--!strict
-- Добыча, переработка и грузовики — перенос hauling.ts, refining.ts и dispatch из logistics.ts. Шахты добывают руду из
-- месторождения под собой в свой склад, переработка превращает свою руду в ресурс, а груз между складом и грузовиком
-- переносит луч грузовика: ему достаточно встать в радиусе, очередей нет.
--
-- Привязанный к шахте грузовик (приказ haul) возит её руду на переработку. Свободному работу даёт диспетчер: подвезти
-- заказанное или увезти готовое из переработки в хранилище (lib/logistics). Работа — забрать груз со склада from и
-- сгрузить на склад to. Пропал склад, кончился груз или место — грузовик ищет другой или бросает работу.
--
-- Пока нет: дропов (груз, которому некуда деться, остаётся в кузове), маршрутов и ручных приказов, «обеспечить» и
-- «вывезти дроп», нормы поиска подъезда на тик, уровней шахт и переработки, возобновления месторождений.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local approach = require("lib/approach")
local economy = require("lib/economy")
local kinds = require("lib/kinds")
local beams = require("lib/beam")
local beamFor, reaches, transfer = beams.beamFor, beams.reaches, beams.transfer

local mechanic = {}

local NONE = -1
local EPSILON = goods.EPSILON

mechanic.data = {
	-- Раз во сколько тиков грузовик, не дотянувшийся до луча или не нашедший, куда выгрузиться, пробует снова
	-- (RETRY_TICKS), и раз во сколько диспетчер раздаёт работу (DISPATCH_TICKS).
	retryTicks = 20,
	dispatchTicks = 10,
	-- После скольких промахов подъезда подряд подъезда нет (GIVE_UP), самая долгая отсрочка — 2^maxBackoff попыток
	-- (MAX_BACKOFF), сколько секунд к зданию не дают работы (UNREACHABLE_SECONDS).
	giveUp = 3,
	maxBackoff = 5,
	unreachableSeconds = 120,
	-- Сколько руды переработка принимает в секунду и сколько её уходит на единицу ресурса (REFINE_RATE, REFINE_RATIO).
	refineRate = 1.5,
	refineRatio = 1,
}

mechanic.components = {
	-- Склад: груз → сколько, объём, что сюда кладут, пределы, резерв хранилища (lib/goods).
	Inventory = { items = {}, capacity = 0, accepts = {}, limits = {}, reserve = 0 },
	-- Транспортный луч: переносит груз между своим складом и чужим, если между краями не больше radius; give — умеет
	-- отдавать, take — забирать, rate — единиц в секунду на склад; links — с кем работал в этот тик (подаче).
	Beam = { radius = 2, rate = 10, give = true, take = true, links = {} },
	-- Грузовик: mine — шахта, к которой привязан; работа — до amount груза resource со склада from на склад to; full —
	-- набрал и едет к to; loading — грузится или сгружается в этот тик; waiting — уже ищет подъезд; misses — промахи
	-- подъезда подряд; filter — что возит (пусто — всё); trapped — обстроен и выехать ему некуда.
	Hauler = { mine = -1, from = -1, to = -1, resource = "", amount = 0, full = false, loading = false, waiting = false, misses = 0, filter = {}, trapped = false },
	-- Грузовикам игрока не подъехать к этому зданию до тика until: работы сюда не дают, игрок видит значок.
	Unreachable = { ["until"] = 0 },
}

local function onTurn(ctx, e: number, ticks: number): boolean
	return (ctx.tick + e) % ticks == 0
end

local function ownerOf(w, e: number): number
	local owner = w:get(e, "Owner")
	return if owner then owner.player else 0
end

-- Может ли игрок привязать грузовики к этому зданию: его готовая шахта (canHaul).
local function canHaul(w, player: number, mine: number): boolean
	return logistics.isReady(w, player, mine) and logistics.dataOf(w, mine).extract == true
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

-- Бросает работу; груз остаётся в кузове (dropJob).
local function dropJob(w, truck: number)
	local hauler = w:get(truck, "Hauler")
	hauler.from, hauler.to = NONE, NONE
	hauler.amount = 0
	hauler.full, hauler.loading, hauler.waiting = false, false, false
end

-- Снимает грузовик с работы и с шахты (releaseHauler): дальше работу ему даст диспетчер.
local function release(w, truck: number)
	local hauler = w:get(truck, "Hauler")
	if not hauler then
		return
	end
	hauler.mine = NONE
	dropJob(w, truck)
end

-- Можно ли вернуть груз туда, откуда взят: здание стоит и место есть.
local function returnsTo(w, building: number, good: string): boolean
	local stock = w:alive(building) and w:get(building, "Inventory")
	return stock ~= nil and stock ~= false and w:has(building, "Building") and goods.room(stock, good) > EPSILON
end

-- Ближайший заказчик этого груза; nil — никто не ждёт (requesterFor).
local function requesterFor(w, truck: number, good: string): number?
	local at = w:get(truck, "Position")
	local best, bestDistance = nil, math.huge
	for _, request in logistics.requests(w, ownerOf(w, truck), logistics.flows(w)) do
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

-- Пора ли снова искать подъезд (seekDue): получивший работу трогается сразу, остальные — всё реже после промахов.
local function seekDue(ctx, truck: number, hauler): boolean
	if not hauler.waiting then
		return true
	end
	return onTurn(ctx, truck, mechanic.data.retryTicks * 2 ^ math.min(hauler.misses, mechanic.data.maxBackoff))
end

-- Заперт ли грузовик: из его тайла технике не выехать дальше кармана (walledIn).
local function walledIn(ctx, truck: number): boolean
	local at = ctx:get(truck, "Position")
	return at ~= nil and (ctx:reach(at.x, at.y, approach.POCKET)) < approach.POCKET
end

-- Подводит грузовик к зданию на длину луча (seekBeam); после giveUp промахов подряд — заперт сам или здание
-- недоступно (Unreachable). Подъехал — отметки снимаются.
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
-- переработку, заказчику или обратно; нет такого — остаётся в кузове. Запертый груз держит.
local function abandon(w, truck: number, building: number)
	local hauler = w:get(truck, "Hauler")
	hauler.misses = 0
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
		dropJob(w, truck)
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

-- Выработана ли шахта: в месторождении и в её складе пусто (isSpent).
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
	return hauler.mine == NONE and hauler.from == NONE and hauler.to == NONE and (not cargo or goods.load(cargo) <= EPSILON) and not w:has(truck, "Path") and not w:has(truck, "Converting")
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
		local player = ownerOf(w, truck)
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
			if not logistics.isReady(w, player, e) or w:has(e, "Converting") then
				continue
			end
			local data = logistics.dataOf(w, e)
			if data.refines or data.assembles or data.researches then
				table.insert(outlets, e)
			elseif data.extract then
				table.insert(mines, e)
			end
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
		local function hasLocal(network, to: number, good: string, least: number): boolean
			for _, source in network.members do
				if source ~= to and table.find(logistics.offers(w, source), good) and logistics.given(w, source, good) >= least then
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
			local best = nil
			for _, request in requests do
				if request.amount < d.MIN_JOB or not carries(request.resource) or logistics.unreachable(w, request.to) then
					continue
				end
				-- Внутри сети груз идёт по трубам: грузовик везёт только то, чего в сети заказчика нет, — из других сетей.
				local network = logistics.networkOf(w, request.to)
				if network and hasLocal(network, request.to, request.resource, math.min(request.amount, d.MIN_JOB)) then
					continue
				end
				local found = false
				local function look(sources: { number })
					for _, source in sources do
						if source == request.to or logistics.unreachable(w, source) or (request.source == "mines" and bound[source]) then
							continue
						end
						if network and logistics.networkOf(w, source) == network then
							continue
						end
						if not table.find(logistics.offers(w, source), request.resource) then
							continue
						end
						local available = logistics.available(w, flows, source, request.resource)
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
					local localZone = request.zone and not network
					look(if localZone then request.zone.members else anyZone())
					-- В своей зоне взять нечего — из любой своей.
					if not found and localZone then
						look(anyZone())
					end
				end
			end
			if not best then
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
						local available = logistics.available(w, flows, source, good)
						local holds = math.min(stock.limits[good] or stock.capacity, stock.capacity)
						-- Вставшая переработка — руды нет и её не везут — увозит и крошки; цех — остатки прежнего сырья.
						local incoming = flows.incoming[source]
						local stopped = data.refines ~= nil and goods.amount(stock, data.refines) <= EPSILON and (if incoming then incoming[data.refines] or 0 else 0) <= 0
						local leftover = stopped or data.researches == true or (data.assembles ~= nil and not goods.isProduct(w, good))
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
		if type(truck) == "number" and ctx:alive(truck) and ctx:has(truck, "Hauler") and ownerOf(ctx, truck) == player then
			-- Тронется сам в ближайший тик: гружёный — в хранилище, пустой — к шахте.
			ctx:set(truck, "Hauler", { mine = mine, from = NONE, to = NONE, amount = 0, full = false, loading = false, waiting = false })
			ctx:stop(truck)
			any = true
		end
	end
	return any
end

mechanic.commands = {
	-- { mine, units } — привязать свои грузовики к своей шахте: возят только её руду на переработку.
	haul = function(ctx, player, args)
		if type(args.mine) == "number" and type(args.units) == "table" then
			assign(ctx, player, args.mine, args.units)
		end
	end,
}

mechanic.on = {
	-- Приказ точкой (mechanics/orders): грузовики по своей шахте.
	haul = function(ctx, event)
		assign(ctx, event.player, event.mine, event.units)
	end,
	-- Приказ идти снимает грузовик с работы и шахты; груз остаётся в кузове.
	release = function(ctx, event)
		for _, truck in event.units do
			if ctx:alive(truck) and ctx:has(truck, "Hauler") then
				ctx:set(truck, "Hauler", { mine = NONE, from = NONE, to = NONE, amount = 0, full = false, loading = false, waiting = false })
			end
		end
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
				local wanted = math.min(d.refineRate * ctx.dt * economy.shareOf(ctx, e), has)
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
		query = { "Hauler" },
		after = { "construct" },
		before = { "fight" },
		run = function(_, ctx)
			local d = mechanic.data
			local w = goods.book(ctx, { "Inventory", "Hauler", "Beam" })
			-- Лучи забывают, с кем работали в прошлом тике.
			for _, e in ctx:each({ "Beam" }) do
				local beam = w:get(e, "Beam")
				if #beam.links > 0 then
					beam.links = {}
				end
			end
			-- Шахты добывают руду в свой склад, пока там есть место; что и как быстро — решает месторождение.
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
				local rate = kinds.of(ctx, deposit).data.rate
				local taken = math.min(rate * ctx.dt, goods.room(stock, ore), spot.reserve)
				if taken > 0 then
					goods.put(stock, ore, taken)
					ctx:set(deposit, "Deposit", { reserve = spot.reserve - taken })
				end
			end

			local seeking, working, released, dropped, homeless = {}, {}, {}, {}, {}
			for _, truck in ctx:each({ "Hauler", "Owner", "Inventory" }) do
				local hauler = w:get(truck, "Hauler")
				local player = ownerOf(ctx, truck)
				local cargo = w:get(truck, "Inventory")
				hauler.loading = false
				if hauler.mine ~= NONE and not canHaul(w, player, hauler.mine) then
					-- Шахты больше нет: грузовик свободен, груз остаётся в кузове.
					table.insert(released, truck)
					continue
				end
				if ctx:has(truck, "Path") or ctx:has(truck, "Converting") then
					continue
				end
				local retry = onTurn(ctx, truck, d.retryTicks)
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
				local player = ownerOf(w, truck)
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
			end

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
