--!strict
-- Добыча, переработка и грузовики. Шахты добывают руду из месторождения под собой в свой склад, переработка превращает
-- свою руду в ресурс, а груз между складом и грузовиком переносит луч грузовика: ему достаточно встать в радиусе,
-- очередей нет.
--
-- Привязанный к шахте грузовик (приказ haul) возит её руду на переработку. Свободному работу даёт диспетчер: подвезти
-- заказанное или увезти готовое из переработки в хранилище (lib/logistics). Работа — забрать груз со склада from и
-- сгрузить на склад to. Пропал склад, кончился груз или место — грузовик ищет другой или бросает работу.
--
-- Дропы (lib/drops) в своих зонах свободные грузовики вывозят сами, приказ pickup — где бы те ни лежали. Груз, который
-- некуда везти, потому что к принимающему не подъехать, грузовик бросает на землю.
--
-- Приказы игрока: маршрут — здания-остановки по кругу; обслуживание — возить только по заявкам этих зданий, беря груз
-- где угодно у игрока; «обеспечить» — то же для одного здания, пока его заявки не кончатся; ручная перевозка (Carry) —
-- взять здесь, отвезти туда; фильтр — какие грузы возить; резерв хранилищ и заказ станций запроса. Пока нет: нормы
-- поиска подъезда на тик.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local approach = require("lib/approach")
local economy = require("lib/economy")
local kinds = require("lib/kinds")
local beams = require("lib/beam")
local queue = require("lib/queue")
local drops = require("lib/drops")
local levels = require("lib/levels")
local world = require("lib/world")
local beamFor, reaches, transfer = beams.beamFor, beams.reaches, beams.transfer

local mechanic = {}

-- Объявлены ниже, зовутся раньше.
local assignSupply, runRoutes, runCarry

local NONE = -1
local EPSILON = goods.EPSILON

mechanic.data = {
	-- Раз во сколько тиков грузовик, не дотянувшийся до луча или не нашедший, куда выгрузиться, пробует снова, и раз во
	-- сколько диспетчер раздаёт работу.
	retryTicks = 20,
	dispatchTicks = 10,
	-- После скольких промахов подъезда подряд подъезда нет, самая долгая отсрочка — 2^maxBackoff попыток, сколько
	-- секунд к зданию не дают работы.
	giveUp = 3,
	maxBackoff = 5,
	unreachableSeconds = 120,
	-- Сколько руды переработка принимает в секунду и сколько её уходит на единицу ресурса.
	refineRate = 1.5,
	refineRatio = 1,
	-- Сколько остановок в маршруте и зданий в обслуживании.
	routeLimit = 8,
	serveLimit = 16,
}

mechanic.components = {
	-- Склад: груз → сколько, объём, что сюда кладут, пределы, резерв хранилища (lib/goods).
	Inventory = { items = {}, capacity = 0, accepts = {}, limits = {}, reserve = 0 },
	-- Транспортный луч: переносит груз между своим складом и чужим, если между краями не больше radius; give — умеет
	-- отдавать, take — забирать, rate — единиц в секунду на склад; links — с кем работал в этот тик (подаче).
	Beam = { radius = 2, rate = 10, give = true, take = true, links = {} },
	-- Грузовик: mine — шахта, к которой привязан; работа — до amount груза resource со склада from на склад to; full —
	-- набрал и едет к to; loading — грузится или сгружается в этот тик; waiting — уже ищет подъезд; misses — промахи
	-- подъезда подряд; filter — что возит (пусто — всё); trapped — обстроен и выехать ему некуда; pickup — дроп, который
	-- велено вывезти; route — остановки маршрута по кругу, stop — к какой едет сейчас; serve — здания, которые он
	-- обслуживает; supply — здание, которое велено обеспечить.
	Hauler = { mine = -1, from = -1, to = -1, resource = "", amount = 0, full = false, loading = false, waiting = false, misses = 0, filter = {}, trapped = false, pickup = -1, route = {}, stop = 0, serve = {}, supply = -1 },
	-- Ручной приказ грузовику: left груза resource со склада from (-1 — что уже в кузове) на склад to; full — набрал и
	-- едет к получателю.
	Carry = { from = -1, to = -1, resource = "", left = 0, full = false },
	-- Заказ станции запроса: груз → сколько держать.
	Wanted = { items = {} },
	-- Грузовикам игрока не подъехать к этому зданию до тика until: работы сюда не дают, игрок видит значок.
	Unreachable = { ["until"] = 0 },
}

-- Снаряжение вида: станция запроса держит заказанное игроком, у кого data.beam — транспортный луч, грузовик (data.hauls)
-- работает.
function mechanic.equip(kind, entity)
	local data = kind.data
	if data.requester then
		entity.Wanted = {}
	end
	if data.beam then
		entity.Beam = { radius = data.beam.radius, rate = data.beam.rate, give = data.beam.give == true, take = data.beam.take == true }
	end
	if data.hauls then
		entity.Hauler = {}
	end
end

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
	return world.onTurn(ctx, truck, mechanic.data.retryTicks * 2 ^ math.min(hauler.misses, mechanic.data.maxBackoff))
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
	local d = mechanic.data
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
	if hauler.misses >= mechanic.data.giveUp and (hauler.trapped or logistics.unreachable(w, building)) then
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

-- Раздаёт работу свободным грузовикам (dispatch): каждому — лучшая из заявок его игрока, важнее и ближе; заявок нет —
-- увозит готовое из переработки в хранилище.
local function dispatch(w)
	-- Отметки «не подъехать», чей срок вышел, снимаются.
	for _, e in w:each({ "Unreachable" }) do
		if w:get(e, "Unreachable")["until"] <= w.tick then
			w:remove(e, "Unreachable")
		end
	end
	local idle: { [number]: { number } } = {}
	local any = false
	for _, truck in w:each({ "Hauler", "Owner", "Unit" }) do
		if not isIdle(w, truck) then
			continue
		end
		local hauler = w:get(truck, "Hauler")
		-- Запертому работы не дают, пока ему не откроют проход.
		if hauler.trapped then
			hauler.trapped = walledIn(w, truck)
			if hauler.trapped then
				continue
			end
		end
		local player = world.ownerOf(w, truck)
		idle[player] = idle[player] or {}
		table.insert(idle[player], truck)
		any = true
	end
	if not any then
		return
	end
	local flows = logistics.flows(w)
	local d = logistics
	for player, trucks in idle do
		local requests = logistics.requests(w, player, flows)
		local outlets, mines = {}, {}
		for _, e in w:each({ "Building", "Inventory" }) do
			if not world.isReady(w, player, e) or w:has(e, "Converting") then
				continue
			end
			local data = logistics.dataOf(w, e)
			if data.refines or data.assembles or data.researches or data.trades or data.requester then
				table.insert(outlets, e)
			elseif data.extract then
				table.insert(mines, e)
			end
		end
		-- Дропы ничьи: их подбирает любой, но сам — только в своих зонах. За дропом на другом краю карты грузовик без
		-- приказа не едет. С дропа везут и по заявкам — как со склада зоны; руду с него — на переработку.
		local zoneDrops = {}
		local function dropsOf(network): { number }
			local found = zoneDrops[network]
			if not found then
				found = logistics.dropsIn(w, network)
				zoneDrops[network] = found
			end
			return found
		end
		local seenDrops, allDrops = {}, {}
		for _, network in w:networks() do
			if network.player == player then
				for _, drop in dropsOf(network) do
					if not seenDrops[drop] then
						seenDrops[drop] = true
						table.insert(allDrops, drop)
						table.insert(outlets, drop)
						table.insert(mines, drop)
					end
				end
			end
		end
		-- Откуда брать готовое для заявки зоны: её здания и дропы в ней; считается раз на зону.
		local zoneSources = {}
		local function sourcesIn(network): { number }
			local found = zoneSources[network]
			if not found then
				found = table.clone(network.members)
				for _, drop in dropsOf(network) do
					table.insert(found, drop)
				end
				zoneSources[network] = found
			end
			return found
		end
		-- У шахты с привязанным грузовиком свой возчик: свободные её руду не трогают.
		local bound = {}
		for _, truck in w:each({ "Hauler" }) do
			local mine = w:get(truck, "Hauler").mine
			if mine ~= NONE then
				bound[mine] = true
			end
		end
		-- Есть ли в сети поставщик груза для заказчика — тогда его везут трубы; есть ли хранилище, куда груз поместится.
		local function hasLocal(network, to: number, good: string, least: number, sale: boolean?): boolean
			for _, source in network.members do
				if source ~= to and not logistics.barred(w, to, source) and table.find(logistics.offers(w, source), good) and logistics.given(w, source, good, sale) >= least then
					return true
				end
			end
			return false
		end
		local function hasStore(network, good: string): boolean
			for _, store in network.members do
				if logistics.isStore(w, store) and logistics.space(w, store, good, flows) > EPSILON then
					return true
				end
			end
			return false
		end
		-- Откуда брать готовое: здания сети заказчика, а нет там — любой своей сети.
		-- Заявки без учёта того, что уже везут: по ним видно, нужно ли ещё что-то тому, что велено обеспечить.
		local needs = nil
		local everywhere = nil
		local function anyZone(): { number }
			if not everywhere then
				local list = {}
				for _, network in w:networks() do
					if network.player == player then
						for _, member in network.members do
							table.insert(list, member)
						end
					end
				end
				for _, drop in allDrops do
					table.insert(list, drop)
				end
				everywhere = list
			end
			return everywhere :: { number }
		end
		for _, truck in trucks do
			local room = w:get(truck, "Inventory").capacity
			local hauler = w:get(truck, "Hauler")
			local filter = hauler.filter
			local function carries(good: string): boolean
				return #filter == 0 or table.find(filter, good) ~= nil
			end
			-- Снесённые и потерянные здания из обслуживания выпадают; не осталось ни одного — грузовик снова общий.
			if #hauler.serve > 0 then
				local kept = {}
				for _, building in hauler.serve do
					if world.isReady(w, player, building) and w:has(building, "Inventory") then
						table.insert(kept, building)
					end
				end
				hauler.serve = kept
			end
			-- Приказ обеспечить исполнен, когда у цели не осталось заявок, даже тех, что уже везут другие: грузовик свободен.
			if hauler.supply ~= NONE then
				needs = needs or logistics.requests(w, player, { incoming = {}, outgoing = {} })
				local open = false
				for _, request in needs :: { any } do
					open = open or request.to == hauler.supply
				end
				if not open then
					hauler.supply = NONE
				end
			end
			local serving: { [number]: boolean }? = nil
			if hauler.supply ~= NONE then
				serving = { [hauler.supply] = true }
			elseif #hauler.serve > 0 then
				serving = {}
				for _, building in hauler.serve do
					(serving :: any)[building] = true
				end
			end
			local best = nil
			for _, request in requests do
				if request.amount < d.MIN_JOB or not carries(request.resource) or logistics.unreachable(w, request.to) then
					continue
				end
				if serving and not serving[request.to] then
					continue
				end
				-- Внутри сети груз идёт по трубам: грузовик везёт только то, чего в сети заказчика нет, — из других сетей.
				-- Обслуживающий везёт и внутри сети.
				local network = if serving then nil else logistics.networkOf(w, request.to)
				if network and hasLocal(network, request.to, request.resource, math.min(request.amount, d.MIN_JOB), request.sale) then
					continue
				end
				local found = false
				local function look(sources: { number })
					for _, source in sources do
						if source == request.to or logistics.unreachable(w, source) or (request.source == "mines" and bound[source]) then
							continue
						end
						if (network and logistics.networkOf(w, source) == network) or logistics.barred(w, request.to, source) then
							continue
						end
						if not table.find(logistics.offers(w, source), request.resource) then
							continue
						end
						local available = logistics.available(w, flows, source, request.resource, request.sale)
						if available < math.min(request.amount, d.MIN_JOB) then
							continue
						end
						found = true
						local score = request.priority * d.PRIORITY_WEIGHT - logistics.distance(w, truck, source) - logistics.distance(w, source, request.to)
						if best and score <= best.score then
							continue
						end
						best = { from = source, to = request.to, resource = request.resource, amount = math.min(request.amount, available, room), score = score }
					end
				end
				if request.source == "mines" then
					look(mines)
				else
					local localZone = request.zone and not network and not serving
					look(if localZone then sourcesIn(request.zone) else anyZone())
					-- В своей зоне взять нечего — из любой своей.
					if not found and localZone then
						look(anyZone())
					end
				end
			end
			if not best and not serving then
				-- Заявок нет — увозит готовое из переработки; куда — решается сразу, и не больше, чем там поместится.
				for _, source in outlets do
					if logistics.unreachable(w, source) then
						continue
					end
					local stock = w:get(source, "Inventory")
					local data = logistics.dataOf(w, source)
					local network = logistics.networkOf(w, source)
					for _, good in logistics.offers(w, source) do
						if not carries(good) then
							continue
						end
						-- Есть куда отправить по трубам своей сети — грузовик не нужен.
						if network and hasStore(network, good) then
							continue
						end
						-- Станция запроса отдаёт в хранилища только лишнее сверх заказа.
						local requester = logistics.isRequester(w, source)
						local available = logistics.available(w, flows, source, good)
						if requester then
							available = math.min(available, logistics.surplusOf(w, source, good))
						end
						local holds = math.min(stock.limits[good] or stock.capacity, stock.capacity)
						-- Вставшая переработка — руды нет и её не везут — увозит и крошки; цех — остатки прежнего сырья; с дропа
						-- увозят всё до крошки.
						local incoming = flows.incoming[source]
						local stopped = data.refines ~= nil and goods.amount(stock, data.refines) <= EPSILON and (if incoming then incoming[data.refines] or 0 else 0) <= 0
						local leftover = stopped or requester or data.researches == true or data.trades == true or (data.assembles ~= nil and not goods.isProduct(w, good)) or drops.is(w, source)
						if available < (if leftover then EPSILON else math.min(d.PUSH_MIN, room, holds * d.PUSH_SHARE)) then
							continue
						end
						local score = -logistics.distance(w, truck, source)
						if best and score <= best.score then
							continue
						end
						local to = logistics.deliveryFor(w, truck, good, source)
						if not to then
							continue
						end
						local space = logistics.space(w, to, good, flows)
						if space <= EPSILON then
							continue
						end
						best = { from = source, to = to, resource = good, amount = math.min(available, room, space), score = score }
					end
				end
			end
			if not best then
				continue
			end
			hauler.from, hauler.to, hauler.resource, hauler.amount = best.from, best.to, best.resource, best.amount
			hauler.full, hauler.waiting = false, false
			logistics.add(flows.outgoing, best.from, best.resource, best.amount)
			logistics.add(flows.incoming, best.to, best.resource, best.amount)
			for _, request in requests do
				if request.to == best.to and request.resource == best.resource then
					request.amount -= best.amount
					break
				end
			end
		end
	end
end

-- Приказы и события, которые раздают грузовикам работу между тиками, ложатся в книгу хоста.
local function assign(ctx, player: number, mine: number, units: { number })
	if not canHaul(ctx, player, mine) then
		return false
	end
	local any = false
	for _, truck in units do
		if type(truck) == "number" and ctx:alive(truck) and ctx:has(truck, "Hauler") and world.ownerOf(ctx, truck) == player then
			-- Тронется сам в ближайший тик: гружёный — в хранилище, пустой — к шахте.
			freed(ctx, truck, { mine = mine })
			any = true
		end
	end
	return any
end

-- Посылает грузовики игрока вывезти дроп: они бросают прежнюю работу и шахту и возят с него груз рейсами в хранилища и
-- на переработку, где бы он ни лежал, пока он не опустеет. Потом свободны.
local function assignPickup(ctx, player: number, drop: number, units: { number })
	if not canPickup(ctx, drop) then
		return false
	end
	local any = false
	for _, truck in units do
		if type(truck) == "number" and ctx:alive(truck) and ctx:has(truck, "Hauler") and world.ownerOf(ctx, truck) == player then
			freed(ctx, truck, { pickup = drop })
			any = true
		end
	end
	return any
end


-- Свои грузовики из списка: юниты с Hauler игрока, без повторов.
local function trucksOf(ctx, player: number, units: any): { number }
	local list, seen = {}, {}
	if type(units) ~= "table" then
		return list
	end
	for _, truck in units do
		if type(truck) == "number" and not seen[truck] and ctx:alive(truck) and ctx:has(truck, "Hauler") and ctx:has(truck, "Unit") and world.ownerOf(ctx, truck) == player then
			seen[truck] = true
			table.insert(list, truck)
		end
	end
	return list
end

-- Годится ли здание в остановку маршрута или обслуживание: своё готовое здание со складом.
local function isStop(w, player: number, building: any): boolean
	return type(building) == "number" and world.isReady(w, player, building) and w:has(building, "Inventory")
end

-- Посылает грузовики игрока обеспечить здание или стройку: они бросают прежнюю работу и возят только по его заявкам,
-- беря груз где угодно у игрока, пока заявки не кончатся. У кого нужное уже в кузове — везёт сразу.
assignSupply = function(ctx, player: number, target: any, units: any): boolean
	if not logistics.canSupply(ctx, player, target) then
		return false
	end
	local trucks = trucksOf(ctx, player, units)
	for _, truck in trucks do
		local fields: { [string]: any } = { supply = target }
		local carried = carriedBy(ctx, truck)
		if carried and logistics.accepts(ctx, player, target, carried) then
			fields.resource, fields.to, fields.full = carried, target, true
		end
		freed(ctx, truck, fields)
	end
	return #trucks > 0
end

-- Возит ли грузовик этот груз: фильтр пуст или груз в нём есть.
local function carries(filter: { string }, good: string): boolean
	return #filter == 0 or table.find(filter, good) ~= nil
end

-- Что грузовику взять на остановке from, чтобы сгрузить на следующей to: первый груз из разрешённых фильтром, который
-- from отдаёт, у него есть и to примет. nil — брать нечего.
local function pickFor(w, player: number, filter: { string }, from: number, to: number, except: string?): string?
	for _, good in logistics.offers(w, from) do
		if good ~= except and carries(filter, good) and logistics.given(w, from, good) > EPSILON and logistics.accepts(w, player, to, good) then
			return good
		end
	end
	return nil
end

-- Грузовик уезжает к остановке stop (с нуля): разгрузка и погрузка начнутся заново.
local function leave(hauler, stop: number)
	hauler.stop = stop
	hauler.full = false
	hauler.amount = 0
end

-- Грузовики с маршрутом объезжают его. На остановке грузовик сгружает то, что она принимает, и берёт то, что примет
-- следующая, кроме только что привезённого сюда; разгрузился и загрузился — едет дальше. Пустой, которому здесь брать
-- нечего, едет к ближайшей по кругу остановке, где груз для следующей есть; нет такой — ждёт. Пропавшие остановки
-- выпадают, и с одной маршрут кончается. Поля работы у такого грузовика свободны: full — разгрузка кончилась, resource
-- при amount > 0 — что он здесь сгрузил.
runRoutes = function(ctx, w)
	local seeking, ended = {}, {}
	for _, truck in ctx:each({ "Hauler", "Owner", "Inventory" }) do
		local hauler = w:get(truck, "Hauler")
		if #hauler.route == 0 or ctx:has(truck, "Path") or ctx:has(truck, "Converting") then
			continue
		end
		local player = world.ownerOf(ctx, truck)
		local cargo = w:get(truck, "Inventory")
		local kept = {}
		for _, stop in hauler.route do
			if isStop(w, player, stop) then
				table.insert(kept, stop)
			end
		end
		if #kept ~= #hauler.route then
			hauler.route = kept
			hauler.stop = 0
		end
		local route = hauler.route
		if #route < 2 then
			table.insert(ended, truck)
			continue
		end
		hauler.stop %= #route
		local retry = world.onTurn(ctx, truck, mechanic.data.retryTicks)
		local here = route[hauler.stop + 1]
		if not reaches(w, truck, here) and not reaches(w, here, truck) then
			if seekDue(ctx, truck, hauler) then
				table.insert(seeking, { truck = truck, building = here })
			end
			hauler.waiting = true
			continue
		end
		hauler.waiting = false
		local nextStop = route[(hauler.stop + 1) % #route + 1]
		-- Сначала сгружает всё, что здесь принимают, и только потом грузится: иначе на складе, который и принимает, и
		-- отдаёт, перекладывал бы один и тот же груз туда и обратно.
		if not hauler.full then
			local carried = carriedBy(w, truck)
			local moved = if carried and logistics.accepts(w, player, here, carried) then transfer(w, truck, here, carried) else 0
			hauler.loading = moved > 0
			if moved > 0 then
				-- Привезённое сюда отсюда же и не забирают.
				hauler.resource, hauler.amount = carried, 1
				continue
			end
			hauler.full = true
		end
		-- Берёт для следующей остановки: тот же груз, что уже в кузове, или первый подходящий.
		local carried = carriedBy(w, truck)
		local unloaded = if hauler.amount > 0 then hauler.resource else nil
		local wanted = carried or pickFor(w, player, hauler.filter, here, nextStop, unloaded)
		local moved = 0
		if wanted and wanted ~= unloaded and goods.room(cargo, wanted) > EPSILON and table.find(logistics.offers(w, here), wanted) and logistics.given(w, here, wanted) > EPSILON and logistics.accepts(w, player, nextStop, wanted) then
			moved = transfer(w, here, truck, wanted, math.min(goods.room(cargo, wanted), logistics.given(w, here, wanted)))
		end
		hauler.loading = moved > 0
		if moved > 0 then
			continue
		end
		if carriedBy(w, truck) then
			leave(hauler, (hauler.stop + 1) % #route)
			continue
		end
		-- Пустой и брать здесь нечего: едет туда, где груз есть, а нет его нигде — ждёт.
		if not retry then
			continue
		end
		for step = 1, #route - 1 do
			local index = (hauler.stop + step) % #route
			if pickFor(w, player, hauler.filter, route[index + 1], route[(index + 1) % #route + 1]) then
				leave(hauler, index)
				break
			end
		end
	end
	for _, truck in ended do
		local hauler = w:get(truck, "Hauler")
		hauler.route, hauler.stop = {}, 0
	end
	for _, job in seeking do
		seekBeam(w, job.truck, job.building, beamFor(w, job.truck, job.building) or beamFor(w, job.building, job.truck))
	end
end

-- Чужой груз в кузове: первый, которого там хоть сколько-то и который не приказной.
local function foreignCargo(w, truck: number, good: string): string?
	local cargo = w:get(truck, "Inventory")
	for _, name in goods.names(w) do
		if name ~= good and goods.amount(cargo, name) > EPSILON then
			return name
		end
	end
	return nil
end

-- Грузовики с ручным приказом возят по нему: рейсами, пока не перевезут заданное. Приказ кончается, когда перевезено
-- всё, источник опустел, а кузов пуст, получателю некуда класть или здание пропало; чужой груз в кузове приказ не
-- возит. Груз в кузове тогда, как после любой отмены, грузовик отвезёт в хранилище сам.
runCarry = function(ctx, w)
	local seeking, ended = {}, {}
	for _, truck in ctx:each({ "Carry", "Hauler", "Inventory" }) do
		if ctx:has(truck, "Path") or ctx:has(truck, "Converting") then
			continue
		end
		local order = w:get(truck, "Carry")
		local hauler = w:get(truck, "Hauler")
		local cargo = w:get(truck, "Inventory")
		local function finish()
			table.insert(ended, truck)
			hauler.waiting, hauler.loading = false, false
		end
		local to, from, good = order.to, order.from, order.resource
		if not ctx:alive(to) or not ctx:has(to, "Inventory") or foreignCargo(w, truck, good) then
			finish()
			continue
		end
		local carried = goods.amount(cargo, good)
		if not order.full then
			local want = math.min(order.left, carried + goods.room(cargo, good)) - carried
			local spare = if from ~= NONE and ctx:alive(from) and ctx:has(from, "Inventory") then logistics.spare(w, from, good) else 0
			if want > EPSILON and spare > EPSILON then
				if not reaches(w, from, truck) and not reaches(w, truck, from) then
					if seekDue(ctx, truck, hauler) then
						table.insert(seeking, { truck = truck, building = from })
					end
					hauler.waiting = true
					continue
				end
				hauler.waiting = false
				local moved = transfer(w, from, truck, good, math.min(want, spare))
				hauler.loading = moved > EPSILON
				if moved > EPSILON then
					continue
				end
			end
			-- Набрал, сколько нужно и влезает, или брать больше нечего: везёт, что есть, а пустой — приказ кончен.
			if carried <= EPSILON then
				finish()
				continue
			end
			order.full = true
		end
		if carried <= EPSILON then
			if order.left <= EPSILON or order.from == NONE then
				finish()
			else
				order.full = false
			end
			continue
		end
		if not reaches(w, truck, to) and not reaches(w, to, truck) then
			if seekDue(ctx, truck, hauler) then
				table.insert(seeking, { truck = truck, building = to })
			end
			hauler.waiting = true
			continue
		end
		hauler.waiting = false
		local moved = transfer(w, truck, to, good, math.min(carried, order.left))
		hauler.loading = moved > EPSILON
		order.left -= moved
		-- Получателю некуда класть — приказ кончен: остаток грузовик отвезёт в хранилище сам.
		if moved <= EPSILON then
			finish()
		end
	end
	for _, truck in ended do
		w:remove(truck, "Carry")
	end
	for _, job in seeking do
		seekBeam(w, job.truck, job.building, beamFor(w, job.truck, job.building) or beamFor(w, job.building, job.truck))
	end
end

-- Годится ли склад отдать по ручному приказу: своё здание или стройка со складом, или дроп.
local function isCarrySource(ctx, player: number, e: any): boolean
	if type(e) ~= "number" or not ctx:alive(e) or not ctx:has(e, "Inventory") then
		return false
	end
	return drops.is(ctx, e) or (world.ownerOf(ctx, e) == player and not ctx:has(e, "Unit"))
end

-- Годится ли склад принять груз по ручному приказу: своё здание, стройка или юнит со складом, где груз поместится;
-- стройке — только её материалы.
local function isCarryTarget(ctx, player: number, e: any, good: string): boolean
	if type(e) ~= "number" or not ctx:alive(e) or world.ownerOf(ctx, e) ~= player or ctx:has(e, "Hauler") then
		return false
	end
	local stock = ctx:get(e, "Inventory")
	if not stock then
		return false
	end
	if ctx:has(e, "Site") and not table.find(stock.accepts, good) then
		return false
	end
	return goods.room(stock, good) > EPSILON
end

mechanic.commands = {
	-- { units, stops } — маршрут своим грузовикам: свои готовые здания со складом по кругу, не больше routeLimit,
	-- подряд одинаковые склеиваются; меньше двух — маршрут снимается. Грузовик бросает прежние приказы; груз в кузове
	-- повезёт по маршруту.
	route = function(ctx, player, args)
		local trucks = trucksOf(ctx, player, args.units)
		if #trucks == 0 or type(args.stops) ~= "table" then
			return
		end
		local route = {}
		for i, stop in args.stops do
			if i > mechanic.data.routeLimit then
				break
			end
			if isStop(ctx, player, stop) and route[#route] ~= stop then
				table.insert(route, stop)
			end
		end
		if #route > 1 and route[1] == route[#route] then
			table.remove(route)
		end
		queue.forget(ctx, trucks)
		for _, truck in trucks do
			freed(ctx, truck, { route = if #route > 1 then route else {} })
		end
	end,
	-- { units, buildings } — своим грузовикам возить только по заявкам этих своих зданий, беря груз где угодно у
	-- игрока; пусто — снять обслуживание.
	serve = function(ctx, player, args)
		local trucks = trucksOf(ctx, player, args.units)
		if #trucks == 0 or type(args.buildings) ~= "table" then
			return
		end
		local serve, seen = {}, {}
		for _, building in args.buildings do
			if #serve < mechanic.data.serveLimit and not seen[building] and isStop(ctx, player, building) then
				seen[building] = true
				table.insert(serve, building)
			end
		end
		queue.forget(ctx, trucks)
		for _, truck in trucks do
			freed(ctx, truck, { serve = serve })
		end
	end,
	-- { units, goods } — какие грузы возить своим грузовикам; пусто — любые. Начатая работа с грузом, которого фильтр
	-- не пускает, бросается: набранное грузовик отвезёт в хранилище.
	filter = function(ctx, player, args)
		if type(args.goods) ~= "table" then
			return
		end
		local filter = {}
		for _, name in goods.names(ctx) do
			if table.find(args.goods, name) then
				table.insert(filter, name)
			end
		end
		for _, truck in trucksOf(ctx, player, args.units) do
			local hauler = ctx:get(truck, "Hauler")
			local fields: { [string]: any } = { filter = filter }
			if (hauler.from ~= NONE or hauler.to ~= NONE) and #filter > 0 and not table.find(filter, hauler.resource) then
				fields.from, fields.to, fields.amount = NONE, NONE, 0
				fields.full, fields.loading, fields.waiting = false, false, false
				ctx:stop(truck)
			end
			ctx:set(truck, "Hauler", fields)
		end
	end,
	-- { units, from, to, resource, amount } — перевезти amount груза resource из from в to (from = -1 — что уже в
	-- кузове): на всех грузовиков поровну.
	carry = function(ctx, player, args)
		local good, amount, from, to = args.resource, args.amount, args.from, args.to
		if type(good) ~= "string" or not table.find(goods.names(ctx), good) or type(amount) ~= "number" or amount <= 0 or amount ~= amount or from == to then
			return
		end
		if from ~= NONE and not isCarrySource(ctx, player, from) then
			return
		end
		if not isCarryTarget(ctx, player, to, good) then
			return
		end
		local trucks = trucksOf(ctx, player, args.units)
		if #trucks == 0 then
			return
		end
		local share = amount / #trucks
		queue.forget(ctx, trucks)
		for _, truck in trucks do
			freed(ctx, truck)
			local carried = goods.amount(ctx:get(truck, "Inventory"), good)
			ctx:add(truck, "Carry", { from = from, to = to, resource = good, left = if from == NONE then math.min(share, carried) else share, full = from == NONE })
		end
	end,
	-- { units, target } — обеспечить своё здание или стройку, которым нужен груз.
	supply = function(ctx, player, args)
		queue.forget(ctx, trucksOf(ctx, player, args.units))
		assignSupply(ctx, player, args.target, args.units)
	end,
	-- { buildings, amount } — резерв своих готовых хранилищ: столько груза они не выдают никому, кроме продажи; не больше
	-- вместимости, ноль — снять.
	reserve = function(ctx, player, args)
		if type(args.buildings) ~= "table" or type(args.amount) ~= "number" or args.amount ~= args.amount then
			return
		end
		for _, building in args.buildings do
			if type(building) == "number" and world.isReady(ctx, player, building) and logistics.isStore(ctx, building) then
				local stock = ctx:get(building, "Inventory")
				if stock then
					ctx:set(building, "Inventory", { reserve = math.max(0, math.min(stock.capacity, math.round(args.amount))) })
				end
			end
		end
	end,
	-- { buildings, resource, amount } — заказ своих станций запроса: сколько груза держать; ноль — не заказывать. Заказ
	-- всех грузов вместе не больше склада станции; руду не заказывают.
	want = function(ctx, player, args)
		local good = args.resource
		if type(good) ~= "string" or not table.find(goods.names(ctx), good) or goods.isOre(ctx, good) or type(args.amount) ~= "number" or args.amount ~= args.amount or type(args.buildings) ~= "table" then
			return
		end
		for _, building in args.buildings do
			if type(building) ~= "number" or not world.isReady(ctx, player, building) then
				continue
			end
			local wanted, stock = ctx:get(building, "Wanted"), ctx:get(building, "Inventory")
			if not wanted or not stock then
				continue
			end
			local others = 0
			for name, held in wanted.items do
				if name ~= good then
					others += held
				end
			end
			local items = table.clone(wanted.items)
			local nextAmount = math.max(0, math.min(stock.capacity - others, math.round(args.amount)))
			items[good] = if nextAmount > 0 then nextAmount else nil
			ctx:set(building, "Wanted", { items = items })
		end
	end,
	-- { mine, units, queue } — привязать свои грузовики к своей шахте: возят только её руду на переработку; с Shift — в
	-- очередь.
	haul = function(ctx, player, args)
		if type(args.mine) ~= "number" or type(args.units) ~= "table" then
			return
		end
		if args.queue then
			queue.push(ctx, player, "haul", { mine = args.mine }, args.units)
			return
		end
		queue.forget(ctx, args.units)
		assign(ctx, player, args.mine, args.units)
	end,
	-- { drop, units, queue } — вывезти дроп своими грузовиками; с Shift — в очередь.
	pickup = function(ctx, player, args)
		if type(args.drop) ~= "number" or type(args.units) ~= "table" then
			return
		end
		if args.queue then
			queue.push(ctx, player, "pickup", { drop = args.drop }, args.units)
			return
		end
		queue.forget(ctx, args.units)
		assignPickup(ctx, player, args.drop, args.units)
	end,
}

mechanic.on = {
	-- Приказ точкой (mechanics/orders): грузовики по своей шахте.
	haul = function(ctx, event)
		assign(ctx, event.player, event.mine, event.units)
	end,
	-- Приказ точкой: грузовики по дропу.
	pickup = function(ctx, event)
		assignPickup(ctx, event.player, event.drop, event.units)
	end,
	-- Приказ идти снимает грузовик с работы, шахты, маршрута и прочих приказов; груз остаётся в кузове.
	release = function(ctx, event)
		for _, truck in event.units do
			if ctx:alive(truck) and ctx:has(truck, "Hauler") then
				local values = table.clone(RELEASED)
				ctx:set(truck, "Hauler", values)
				ctx:remove(truck, "Carry")
			end
		end
	end,
	-- Приказ точкой: грузовики обеспечивают здание или стройку.
	supply = function(ctx, event)
		assignSupply(ctx, event.player, event.target, event.units)
	end,
}

mechanic.systems = {
	-- После производства: переработка превращает руду в готовое со своей долей энергии, пока ему есть куда лечь.
	refine = {
		query = { "Inventory", "Building" },
		after = { "produce" },
		before = { "plan" },
		run = function(q, ctx)
			local d = mechanic.data
			for i = 0, q.n - 1 do
				local e = buffer.readf64(q.entity, i * 8)
				local kind = kinds.of(ctx, e)
				local ore = kind and kind.data.refines
				if not ore or ctx:has(e, "Site") then
					continue
				end
				local stock = ctx:get(e, "Inventory")
				local has = goods.amount(stock, ore)
				if has <= EPSILON then
					continue
				end
				local product = goods.resourceOf(ctx, ore)
				local wanted = math.min(d.refineRate * levels.factorOf(ctx, e) * ctx.dt * economy.shareOf(ctx, e), has)
				local taken = math.min(wanted, goods.room(stock, product) * d.refineRatio)
				if taken > EPSILON then
					goods.put(stock, product, goods.take(stock, ore, taken) / d.refineRatio)
					ctx:set(e, "Inventory", { items = stock.items })
				end
			end
		end,
	},

	-- После стройки и до боя: шахты добывают, грузовики возят, диспетчер раздаёт работу.
	haul = {
		after = { "construct" },
		before = { "fight" },
		run = function(_, ctx)
			local d = mechanic.data
			local w = goods.book(ctx, { "Inventory", "Hauler", "Beam", "Carry" })
			-- Лучи забывают, с кем работали в прошлом тике.
			for _, e in ctx:each({ "Beam" }) do
				local beam = w:get(e, "Beam")
				if #beam.links > 0 then
					beam.links = {}
				end
			end
			-- Шахты добывают руду в свой склад, пока там есть место; что и как быстро — решает месторождение, а скорость
			-- растёт с уровнем шахты.
			for _, mine in ctx:each({ "Building", "Inventory" }) do
				local kind = kinds.of(ctx, mine)
				if not kind or not kind.data.extract or ctx:has(mine, "Site") then
					continue
				end
				local deposit = logistics.depositUnder(ctx, mine)
				local ore = logistics.mineOre(ctx, mine)
				if not deposit or not ore then
					continue
				end
				local stock = w:get(mine, "Inventory")
				local spot = ctx:get(deposit, "Deposit")
				local rate = kinds.of(ctx, deposit).data.rate * levels.factorOf(ctx, mine)
				local taken = math.min(rate * ctx.dt, goods.room(stock, ore), spot.reserve)
				if taken > 0 then
					goods.put(stock, ore, taken)
					ctx:set(deposit, "Deposit", { reserve = spot.reserve - taken })
				end
			end

			local seeking, working, released, dropped, homeless = {}, {}, {}, {}, {}
			for _, truck in ctx:each({ "Hauler", "Owner", "Inventory" }) do
				local hauler = w:get(truck, "Hauler")
				local player = world.ownerOf(ctx, truck)
				local cargo = w:get(truck, "Inventory")
				hauler.loading = false
				-- Грузовик с маршрутом ездит по нему сам, с ручным приказом — по приказу.
				if #hauler.route > 0 or w:has(truck, "Carry") then
					continue
				end
				if hauler.mine ~= NONE and not canHaul(w, player, hauler.mine) then
					-- Шахты больше нет: грузовик свободен, груз остаётся в кузове.
					table.insert(released, truck)
					continue
				end
				if hauler.pickup ~= NONE and not canPickup(w, hauler.pickup) then
					-- Дроп вывезли или застроили: грузовик свободен.
					table.insert(released, truck)
					continue
				end
				if ctx:has(truck, "Path") or ctx:has(truck, "Converting") then
					continue
				end
				local retry = world.onTurn(ctx, truck, d.retryTicks)
				if hauler.from == NONE and hauler.to == NONE then
					local carried = carriedBy(w, truck)
					if carried then
						-- Остался груз — сначала в хранилище или переработку.
						hauler.resource, hauler.full = carried, true
					elseif hauler.mine ~= NONE then
						local ore = logistics.mineOre(w, hauler.mine)
						-- Шахта выработана и вывезена: грузовик свободен.
						if not ore or isSpent(w, hauler.mine) then
							table.insert(released, truck)
							continue
						end
						-- Руду, которую некуда везти, не берёт: ждёт у шахты. Место бронирует сразу.
						if not retry then
							continue
						end
						-- Переработку в сети шахты руда достигает по трубам: грузовик возит только в другие сети.
						local to = logistics.refineryFor(w, truck, ore, nil, logistics.networkOf(w, hauler.mine))
						if not to then
							continue
						end
						hauler.from, hauler.to, hauler.resource = hauler.mine, to, ore
						hauler.amount = math.min(cargo.capacity, logistics.space(w, to, ore, logistics.flows(w, truck)))
						hauler.full = false
					elseif hauler.pickup ~= NONE then
						-- Следующий рейс с дропа: первый груз, который пускает фильтр и которому есть куда ехать. Фильтр не
						-- пускает ничего из лежащего — приказ снимается; места нет нигде — грузовик ждёт.
						local drop = hauler.pickup
						local list = {}
						for _, good in logistics.offers(w, drop) do
							if #hauler.filter == 0 or table.find(hauler.filter, good) then
								table.insert(list, good)
							end
						end
						if #list == 0 then
							table.insert(released, truck)
							continue
						end
						if not retry then
							continue
						end
						local good, to = nil, nil
						for _, name in list do
							to = logistics.deliveryFor(w, truck, name)
							if to then
								good = name
								break
							end
						end
						if not good or not to then
							continue
						end
						hauler.from, hauler.to, hauler.resource = drop, to, good
						hauler.amount = math.min(cargo.capacity, logistics.space(w, to, good, logistics.flows(w, truck)), logistics.spare(w, drop, good))
						hauler.full = false
					else
						-- Свободный и пустой ждёт работы от диспетчера.
						continue
					end
				end
				if hauler.full then
					local back = hauler.to ~= NONE and hauler.to == hauler.from and returnsTo(w, hauler.to, hauler.resource)
					if hauler.to == NONE or not (back or logistics.accepts(w, player, hauler.to, hauler.resource)) then
						if retry or hauler.to ~= NONE then
							table.insert(homeless, truck)
						end
						hauler.to = NONE
						continue
					end
				elseif not logistics.offersPickup(w, player, hauler.from, hauler.resource) then
					-- Брать нечего. Шахта ещё добывает — ждёт у неё; иначе везёт набранное или бросает работу.
					local mining = hauler.from == hauler.mine and not isSpent(w, hauler.from)
					if not mining then
						if goods.amount(cargo, hauler.resource) > EPSILON then
							hauler.full = true
						else
							table.insert(dropped, truck)
						end
						continue
					end
				end
				local building = if hauler.full then hauler.to else hauler.from
				local toBuilding = hauler.full
				if not (if toBuilding then reaches(w, truck, building) else reaches(w, building, truck)) then
					if seekDue(ctx, truck, hauler) then
						table.insert(seeking, { truck = truck, building = building, toBuilding = toBuilding })
					end
					hauler.waiting = true
					continue
				end
				hauler.waiting = false
				table.insert(working, truck)
			end

			for _, truck in released do
				release(w, truck)
			end
			for _, truck in dropped do
				dropJob(w, truck)
			end
			for _, truck in working do
				local hauler = w:get(truck, "Hauler")
				local cargo = w:get(truck, "Inventory")
				local good = hauler.resource
				if hauler.full then
					hauler.loading = transfer(w, truck, hauler.to, good) > 0
					if goods.amount(cargo, good) <= EPSILON then
						-- Доли копятся с погрешностью: пустой кузов — ровно пустой.
						cargo.items[good] = nil
						dropJob(w, truck)
					elseif goods.room(w:get(hauler.to, "Inventory"), good) <= EPSILON then
						-- Места больше нет — остаток повезёт в другое хранилище.
						table.insert(homeless, truck)
					end
					continue
				end
				local want = hauler.amount - goods.amount(cargo, good)
				hauler.loading = transfer(w, hauler.from, truck, good, want) > 0
				if goods.amount(cargo, good) >= hauler.amount - EPSILON or goods.room(cargo, good) <= EPSILON then
					hauler.full = true
					if hauler.to == NONE then
						table.insert(homeless, truck)
					end
				elseif hauler.from == hauler.mine and isSpent(w, hauler.from) then
					-- Шахта выработана: довозит набранное и освобождается.
					release(w, truck)
				end
			end

			for _, truck in homeless do
				local hauler = w:get(truck, "Hauler")
				local good = carriedBy(w, truck)
				if not good then
					dropJob(w, truck)
					continue
				end
				-- Хранилища полны — груз остаётся в кузове, грузовик пробует снова.
				hauler.resource, hauler.full, hauler.waiting = good, true, false
				local from = hauler.from
				local player = world.ownerOf(w, truck)
				-- Взятое из хранилища и ставшее ненужным едет обратно туда же.
				if from ~= NONE and logistics.isStore(w, from) and not logistics.unreachable(w, from) and logistics.accepts(w, player, from, good) then
					hauler.to = from
					continue
				end
				local other = logistics.deliveryFor(w, truck, good, if from ~= NONE then from else nil)
				local to = other or logistics.deliveryFor(w, truck, good)
				if not to then
					to = requesterFor(w, truck, good)
				end
				if not to and from ~= NONE and not logistics.unreachable(w, from) and returnsTo(w, from, good) then
					to = from
				end
				hauler.to = to or NONE
				-- Места нет только там, куда не подъехать, — груз ложится на землю, как у бросившего работу (abandon).
				-- Просто полные хранилища — другое дело: груз ждёт в кузове, пока место не освободится.
				if not to and not hauler.trapped and blockedTaker(w, player, good) then
					unload(w, truck)
				end
			end

			runRoutes(ctx, w)
			runCarry(ctx, w)
			-- Пустые дропы исчезают.
			drops.sweep(w)
			if ctx.tick % d.dispatchTicks == 0 then
				dispatch(w)
			end
			for _, job in seeking do
				seek(w, job.truck, job.building, job.toBuilding)
			end
			w:flush()
		end,
	},
}

return mechanic
