--!strict
-- Диспетчер свободных грузовиков.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local drops = require("lib/drops")
local world = require("lib/world")
local data = require("./data")
local trucks = require("./trucks")
local walledIn, isIdle = trucks.walledIn, trucks.isIdle

local NONE = -1
local EPSILON = goods.EPSILON

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

return {
	dispatch = dispatch,
}
