--!strict
-- Приказы игрока грузовикам: привязать к шахте, вывезти дроп, обеспечить здание, маршрут — здания-остановки по кругу,
-- ручная перевозка — взять здесь, отвезти туда. Работа по маршрутам и ручным приказам в тике — runRoutes и runCarry.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local beams = require("lib/beam")
local world = require("lib/world")
local data = require("./data")
local trucks = require("./trucks")
local canHaul, carriedBy, freed, canPickup, seekDue, seekBeam = trucks.canHaul, trucks.carriedBy, trucks.freed, trucks.canPickup, trucks.seekDue, trucks.seekBeam
local beamFor, reaches, transfer = beams.beamFor, beams.reaches, beams.transfer

local NONE = -1
local EPSILON = goods.EPSILON

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

-- Посылает грузовики игрока обеспечить здание или стройку: они бросают прежнюю работу и возят только по его заявкам,
-- беря груз где угодно у игрока, пока заявки не кончатся. У кого нужное уже в кузове — везёт сразу.
local function assignSupply(ctx, player: number, target: any, units: any): boolean
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
local function runRoutes(ctx, w)
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
			if logistics.isStop(w, player, stop) then
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
		local retry = world.onTurn(ctx, truck, data.retryTicks)
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
local function runCarry(ctx, w)
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

return {
	assign = assign,
	assignPickup = assignPickup,
	trucksOf = trucksOf,
	assignSupply = assignSupply,
	runRoutes = runRoutes,
	runCarry = runCarry,
}
