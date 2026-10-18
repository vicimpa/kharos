--!strict
-- Работа грузовика: что в кузове, взять и бросить работу, подъехать к зданию на длину луча, отказаться от того, к чему
-- не подъехать, выработана ли шахта, свободен ли грузовик. Общее для системы haul, диспетчера и приказов.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local approach = require("lib/approach")
local beams = require("lib/beam")
local drops = require("lib/drops")
local world = require("lib/world")
local data = require("./data")
local beamFor = beams.beamFor

local NONE = -1
local EPSILON = goods.EPSILON

-- Может ли игрок привязать грузовики к этому зданию: его готовая шахта.
local function canHaul(w, player: number, mine: number): boolean
	return world.isReady(w, player, mine) and logistics.dataOf(w, mine).extract == true
end

-- Что лежит в кузове: первый груз по порядку, которого там есть хоть сколько-то.
local function carriedBy(w, truck: number): string?
	local cargo = w:get(truck, "Inventory")
	if not cargo then
		return nil
	end
	for _, name in goods.names(w) do
		if goods.amount(cargo, name) > EPSILON then
			return name
		end
	end
	return nil
end

-- Бросает работу; груз остаётся в кузове.
local function dropJob(w, truck: number)
	local hauler = w:get(truck, "Hauler")
	hauler.from, hauler.to = NONE, NONE
	hauler.amount = 0
	hauler.full, hauler.loading, hauler.waiting = false, false, false
end

-- Снимает грузовик с работы, шахты, маршрута, обслуживания и ручного приказа: дальше работу ему даст диспетчер.
local function release(w, truck: number)
	local hauler = w:get(truck, "Hauler")
	if not hauler then
		return
	end
	hauler.mine = NONE
	hauler.pickup = NONE
	hauler.serve = {}
	hauler.supply = NONE
	hauler.route = {}
	hauler.stop = 0
	if w:has(truck, "Carry") then
		w:remove(truck, "Carry")
	end
	dropJob(w, truck)
end

-- Всё, что снимает release, — полями для ctx:set вне системы.
local RELEASED = { mine = NONE, pickup = NONE, serve = {}, supply = NONE, route = {}, stop = 0, from = NONE, to = NONE, amount = 0, full = false, loading = false, waiting = false }

-- Снимает грузовик с прежних приказов вне системы (приказ игрока), с полями поверх: fields.
local function freed(ctx, truck: number, fields: { [string]: any }?)
	local values = table.clone(RELEASED)
	for key, value in fields or {} do
		values[key] = value
	end
	ctx:set(truck, "Hauler", values)
	ctx:remove(truck, "Carry")
	ctx:stop(truck)
end

-- Можно ли вывозить этот дроп: он ещё лежит. Дропы ничьи, так что забрать его может любой.
local function canPickup(w, drop: number): boolean
	return w:alive(drop) and drops.is(w, drop)
end

-- Бросает весь груз грузовика на землю дропом под ним и снимает с него работу (unload).
local function unload(w, truck: number)
	local cargo = w:get(truck, "Inventory")
	local at = w:get(truck, "Position")
	drops.put(w, at.x, at.y, cargo.items)
	for good in cargo.items do
		cargo.items[good] = nil
	end
	dropJob(w, truck)
end

-- Принимает ли этот груз хоть одно здание игрока, к которому его грузовикам сейчас не подъехать.
local function blockedTaker(w, player: number, good: string): boolean
	for _, e in w:each({ "Unreachable" }) do
		if logistics.unreachable(w, e) and logistics.accepts(w, player, e, good) then
			return true
		end
	end
	return false
end

-- Можно ли вернуть груз туда, откуда взят: здание стоит и место есть.
local function returnsTo(w, building: number, good: string): boolean
	local stock = w:alive(building) and w:get(building, "Inventory")
	return stock ~= nil and stock ~= false and w:has(building, "Building") and goods.room(stock, good) > EPSILON
end

-- Ближайший заказчик этого груза; nil — никто не ждёт.
local function requesterFor(w, truck: number, good: string): number?
	local at = w:get(truck, "Position")
	local best, bestDistance = nil, math.huge
	for _, request in logistics.requests(w, world.ownerOf(w, truck), logistics.flows(w)) do
		if request.resource ~= good or logistics.unreachable(w, request.to) then
			continue
		end
		local there = w:get(request.to, "Position")
		local far = math.sqrt((there.x - at.x) ^ 2 + (there.y - at.y) ^ 2)
		if far < bestDistance then
			best, bestDistance = request.to, far
		end
	end
	return best
end

-- Пора ли снова искать подъезд: получивший работу трогается сразу, остальные — всё реже после промахов.
local function seekDue(ctx, truck: number, hauler): boolean
	if not hauler.waiting then
		return true
	end
	return world.onTurn(ctx, truck, data.retryTicks * 2 ^ math.min(hauler.misses, data.maxBackoff))
end

-- Заперт ли грузовик: из его тайла технике не выехать дальше кармана.
local function walledIn(ctx, truck: number): boolean
	local at = ctx:get(truck, "Position")
	return at ~= nil and (ctx:reach(at.x, at.y, approach.POCKET)) < approach.POCKET
end

-- Подводит грузовик к зданию на длину луча; после giveUp промахов подряд — заперт сам или здание недоступно
-- (Unreachable). Подъехал — отметки снимаются.
local function seekBeam(w, truck: number, building: number, beam: number?)
	if not beam then
		return
	end
	local hauler = w:get(truck, "Hauler")
	local d = data
	if approach.go(w, truck, building, w:get(beam, "Beam").radius) then
		hauler.misses = 0
		hauler.trapped = false
		if w:has(building, "Unreachable") then
			w:remove(building, "Unreachable")
		end
	else
		hauler.misses += 1
		if hauler.misses >= d.giveUp then
			if walledIn(w, truck) then
				hauler.trapped = true
			else
				w:add(building, "Unreachable", { ["until"] = w.tick + math.round(d.unreachableSeconds / w.dt) })
			end
		end
	end
end

-- Бросает работу, к которой не подъехать (abandon): груз едет туда, куда подъехать можно, — в хранилище или на
-- переработку, заказчику или обратно; нет такого — ложится на землю дропом у грузовика: диспетчер увезёт его, когда
-- появится куда, а сам грузовик свободен. Запертый грузовик груз держит: дроп в его кармане никому не забрать.
local function abandon(w, truck: number, building: number)
	local hauler = w:get(truck, "Hauler")
	hauler.misses = 0
	if hauler.pickup == building then
		hauler.pickup = NONE
	end
	local good = carriedBy(w, truck)
	if not good then
		dropJob(w, truck)
		return
	end
	if hauler.trapped then
		return
	end
	local from = hauler.from
	local to = logistics.deliveryFor(w, truck, good, building) or requesterFor(w, truck, good)
	if not to and from ~= NONE and from ~= building and not logistics.unreachable(w, from) and returnsTo(w, from, good) then
		to = from
	end
	if to then
		hauler.to, hauler.resource, hauler.full, hauler.waiting = to, good, true, false
	else
		unload(w, truck)
	end
end

-- Подводит грузовик к зданию на длину луча, который перенесёт груз между ними (seek).
local function seek(w, truck: number, building: number, toBuilding: boolean)
	seekBeam(w, truck, building, if toBuilding then beamFor(w, truck, building) else beamFor(w, building, truck))
	local hauler = w:get(truck, "Hauler")
	if hauler.misses >= data.giveUp and (hauler.trapped or logistics.unreachable(w, building)) then
		abandon(w, truck, building)
	end
end

-- Выработана ли шахта: в месторождении и в её складе пусто.
local function isSpent(w, mine: number): boolean
	local deposit = logistics.depositUnder(w, mine)
	local ore = logistics.mineOre(w, mine)
	local stock = w:get(mine, "Inventory")
	if not deposit or not ore or not stock then
		return true
	end
	return w:get(deposit, "Deposit").reserve <= 0 and goods.amount(stock, ore) <= EPSILON
end

-- Свободен ли грузовик для диспетчера: не привязан, без работы и груза, стоит.
local function isIdle(w, truck: number): boolean
	local hauler = w:get(truck, "Hauler")
	local cargo = w:get(truck, "Inventory")
	return #hauler.route == 0 and not w:has(truck, "Carry") and hauler.mine == NONE and hauler.pickup == NONE and hauler.from == NONE and hauler.to == NONE and (not cargo or goods.load(cargo) <= EPSILON) and not w:has(truck, "Path") and not w:has(truck, "Converting")
end

return {
	RELEASED = RELEASED,
	canHaul = canHaul,
	carriedBy = carriedBy,
	dropJob = dropJob,
	release = release,
	freed = freed,
	canPickup = canPickup,
	unload = unload,
	blockedTaker = blockedTaker,
	returnsTo = returnsTo,
	requesterFor = requesterFor,
	seekDue = seekDue,
	walledIn = walledIn,
	seekBeam = seekBeam,
	abandon = abandon,
	seek = seek,
	isSpent = isSpent,
	isIdle = isIdle,
}
