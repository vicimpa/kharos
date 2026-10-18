--!strict
-- Зональные заявки — перенос logistics.ts и assembly.ts, общий хосту (ctx) и клиенту (c). Всё, что потребляет груз,
-- само заказывает его у своей зоны: стройка — материалы на здание, производитель — материалы на первый заказ очереди,
-- переработка — руду из своих шахт, где бы они ни стояли, цех — сырьё своего рецепта. Свободные грузовики берут самую
-- важную заявку и везут груз из хранилищ, переработки и цехов зоны; когда заявок нет, развозят готовое по хранилищам.
-- Руду без переработки никто не возит: она копится в шахте. Как ездят грузовики — mechanics/hauling.
--
-- Пока нет: патронов турелям, станций запроса, продажи, дропов, маршрутов и ручных приказов — их заявки
-- придут с их механиками. Внутри сети груз везут трубы (mechanics/pipes): грузовик — только между сетями.

local goods = require("lib/goods")
local kinds = require("lib/kinds")
local research = require("lib/research")

local logistics = {}

-- Что важнее везти (PRIORITY).
logistics.PRIORITY = { site = 4, refine = 3, ammo = 3, production = 2, trade = 1 }
-- Сколько тайлов пути перевешивает одна ступень важности (PRIORITY_WEIGHT).
logistics.PRIORITY_WEIGHT = 1000
-- Сколько готового должно накопиться, чтобы его увезли без заявки: PUSH_MIN или доля склада (PUSH_SHARE).
logistics.PUSH_MIN = 10
logistics.PUSH_SHARE = 0.5
-- Заявки меньше этого не возят (MIN_JOB).
logistics.MIN_JOB = 0.5
-- Сколько каждого сырья нынешней темы лаборатория держит про запас (LAB_STOCK).
logistics.LAB_STOCK = 10

local EPSILON = goods.EPSILON
local NONE = -1

-- Данные вида сущности; нет — пустая таблица.
local function dataOf(w, e: number)
	local kind = kinds.of(w, e)
	return if kind then kind.data else {}
end
logistics.dataOf = dataOf

-- Своё готовое здание (isReady).
function logistics.isReady(w, player: number, e: number): boolean
	local owner = w:alive(e) and w:get(e, "Owner")
	return owner ~= nil and owner ~= false and owner.player == player and w:has(e, "Building") and not w:has(e, "Site")
end

-- Хранилище ли это (isStore).
function logistics.isStore(w, e: number): boolean
	return dataOf(w, e).stores == true
end

local function distance(w, a: number, b: number): number
	local one, two = w:get(a, "Position"), w:get(b, "Position")
	if not one or not two then
		return math.huge
	end
	return math.sqrt((one.x - two.x) ^ 2 + (one.y - two.y) ^ 2)
end
logistics.distance = distance

export type Flows = { incoming: { [number]: { [string]: number } }, outgoing: { [number]: { [string]: number } } }

local function add(map: { [number]: { [string]: number } }, e: number, good: string, amount: number)
	if amount <= 0 then
		return
	end
	local amounts = map[e]
	if not amounts then
		amounts = {}
		map[e] = amounts
	end
	amounts[good] = (amounts[good] or 0) + amount
end
logistics.add = add

-- Что сейчас везут грузовики и строители (flowsOf): набравший везёт то, что в кузове; ещё не набравший обещал привезти и забрать
-- столько, сколько в его работе. except — грузовик, которого не считать.
function logistics.flows(w, except: number?): Flows
	local flows: Flows = { incoming = {}, outgoing = {} }
	-- Пачки в трубах, ещё не пришедшие: их груз уже ушёл со склада отправителя.
	for _, e in w:each({ "Batch" }) do
		local batch = w:get(e, "Batch")
		if batch.arrive > w.tick then
			add(flows.incoming, batch.to, batch.resource, batch.amount)
		end
	end
	for _, truck in w:each({ "Hauler", "Inventory" }) do
		local hauler = w:get(truck, "Hauler")
		if truck == except or (hauler.from == NONE and hauler.to == NONE) then
			continue
		end
		local carried = goods.amount(w:get(truck, "Inventory"), hauler.resource)
		if hauler.to ~= NONE then
			add(flows.incoming, hauler.to, hauler.resource, if hauler.full then carried else math.max(carried, hauler.amount))
		end
		if hauler.from ~= NONE and not hauler.full then
			add(flows.outgoing, hauler.from, hauler.resource, hauler.amount - carried)
		end
	end
	-- Строители, которые сами везут материал на стройку (mechanics/fetching).
	for _, builder in w:each({ "Fetch", "Inventory" }) do
		local fetch = w:get(builder, "Fetch")
		if builder == except then
			continue
		end
		local carried = goods.amount(w:get(builder, "Inventory"), fetch.resource)
		add(flows.incoming, fetch.to, fetch.resource, if fetch.full then carried else math.max(carried, fetch.amount))
		if fetch.from ~= NONE and not fetch.full then
			add(flows.outgoing, fetch.from, fetch.resource, fetch.amount - carried)
		end
	end
	return flows
end

-- Сколько груза на складе можно потратить на нужды самого здания (spareOf).
function logistics.spare(w, e: number, good: string): number
	local stock = w:get(e, "Inventory")
	return if stock then goods.amount(stock, good) else 0
end

-- Сколько склад отдаёт по заявкам (givenBy): хранилище — сверх своего резерва.
function logistics.given(w, e: number, good: string): number
	local stock = w:get(e, "Inventory")
	if not stock then
		return 0
	end
	return math.max(0, goods.amount(stock, good) - (stock.reserve or 0))
end

-- Сколько можно забрать, кроме обещанного другим грузовикам (availableIn).
function logistics.available(w, flows: Flows, e: number, good: string): number
	local out = flows.outgoing[e]
	return math.max(0, logistics.given(w, e, good) - (if out then out[good] or 0 else 0))
end

-- Месторождение под шахтой: то, чья середина совпадает с её серединой; нет — nil.
function logistics.depositUnder(w, mine: number): number?
	local at = w:get(mine, "Position")
	if not at then
		return nil
	end
	for _, e in w:each({ "Deposit", "Position" }) do
		local spot = w:get(e, "Position")
		if spot.x == at.x and spot.y == at.y then
			return e
		end
	end
	return nil
end

-- Какая руда под шахтой (mineOre).
function logistics.mineOre(w, mine: number): string?
	local deposit = logistics.depositUnder(w, mine)
	local kind = deposit and kinds.of(w, deposit)
	return kind and goods.oreOf(w, kind.name)
end

-- На сколько сборок цех держит сырьё про запас (STOCKED_CYCLES).
logistics.STOCKED_CYCLES = 4

-- Сырьё, которое цех сейчас заказывает (inputsOf): у выключенного — никакого, его остатки увозят в хранилища.
function logistics.inputs(w, e: number): { string }
	local assembly = w:get(e, "Assembly")
	local product = assembly and assembly.on and w.protos.goods[assembly.recipe]
	if not product then
		return {}
	end
	local list = {}
	for _, kind in goods.list(w) do
		if product.data.recipe[kind.name] then
			table.insert(list, kind.name)
		end
	end
	return list
end

-- Материалы, которых ждёт сущность (materialsFor): стройка — на здание, производитель — на первый заказ, пока тот не
-- начат. nil — ничего не ждёт.
function logistics.materials(w, e: number): { [string]: number }?
	local site = w:get(e, "Site")
	if site then
		return if site.demolish then nil else dataOf(w, e).materials
	end
	local producer = w:get(e, "Producer")
	if not producer or producer.unit == "" or producer.progress > 0 then
		return nil
	end
	local unit = w.protos.units[producer.unit]
	return unit and unit.data.materials
end

-- Чего из материалов ещё нет на складе (missingFor): пусто — всё на месте.
function logistics.missing(w, e: number): { [string]: number }
	local missing = {}
	for good, amount in logistics.materials(w, e) or {} do
		local lack = amount - logistics.spare(w, e, good)
		-- Крошку меньше погрешности не ждут: стройка её прощает (materialShare).
		if lack > 1e-6 then
			missing[good] = lack
		end
	end
	return missing
end

-- Готовое по порядку грузов.
local function wares(w): { string }
	local list = {}
	for _, kind in goods.list(w) do
		if kind.data.kind ~= "ore" then
			table.insert(list, kind.name)
		end
	end
	return list
end

-- Что здание отдаёт по заявкам (offersOf): хранилище и переработка — готовое, цех — всё, кроме сырья своего рецепта,
-- шахта — свою руду.
function logistics.offers(w, e: number): { string }
	if not w:has(e, "Building") or w:has(e, "Site") then
		return {}
	end
	local data = dataOf(w, e)
	if data.stores or data.refines then
		return wares(w)
	end
	if data.assembles then
		local inputs = logistics.inputs(w, e)
		local list = {}
		for _, good in wares(w) do
			if not table.find(inputs, good) then
				table.insert(list, good)
			end
		end
		return list
	end
	-- Лаборатория отдаёт всё, что не нужно ни нынешней теме, ни головной: остатки прежних увозят обратно.
	if data.researches then
		local owner = w:get(e, "Owner")
		local needs = research.needs(w, if owner then owner.player else 0)
		local list = {}
		for _, name in goods.names(w) do
			if not needs[name] then
				table.insert(list, name)
			end
		end
		return list
	end
	if data.extract then
		local ore = logistics.mineOre(w, e)
		return if ore then { ore } else {}
	end
	return {}
end

-- Сеть сущности по ctx:networks: индекс пересчитывается, когда сети перестроились.
local networkIndex = setmetatable({}, { __mode = "k" }) :: { [any]: { version: number, of: { [number]: any } } }

function logistics.networkOf(w, e: number)
	local key = if w.storage ~= nil then w.storage else w.protos
	local version = w:network_version()
	local found = networkIndex[key]
	if not found or found.version ~= version then
		found = { version = version, of = {} }
		for _, network in w:networks() do
			for _, member in network.members do
				found.of[member] = network
			end
			for _, leaf in network.leaves or {} do
				found.of[leaf] = network
			end
		end
		networkIndex[key] = found
	end
	return found.of[e]
end

export type Request = { to: number, resource: string, amount: number, priority: number, source: string, zone: any? }

-- Сеть, которая кормит сущность: та, куда она входит, или чьи круги накрывают её середину; nil — ни одна.
function logistics.zoneOf(w, player: number, e: number)
	local own = logistics.networkOf(w, e)
	if own then
		return own
	end
	local at = w:get(e, "Position")
	if not at then
		return nil
	end
	for _, network in w:networks() do
		if network.player == player then
			local circles = network.circles
			for i = 1, #circles, 3 do
				if (at.x - circles[i]) ^ 2 + (at.y - circles[i + 1]) ^ 2 <= circles[i + 2] ^ 2 then
					return network
				end
			end
		end
	end
	return nil
end

-- Заявки игрока (requestsOf): что, куда и сколько везти, с учётом того, что уже едет; важные — первыми.
function logistics.requests(w, player: number, flows: Flows): { Request }
	local requests: { Request } = {}
	local function need(to: number, good: string, amount: number, priority: number, source: string)
		local incoming = flows.incoming[to]
		local left = amount - (if incoming then incoming[good] or 0 else 0)
		if left < logistics.MIN_JOB then
			return
		end
		local zone = logistics.zoneOf(w, player, to)
		if source == "mines" or zone then
			table.insert(requests, { to = to, resource = good, amount = left, priority = priority, source = source, zone = zone })
		end
	end
	-- Стройки и производство: материалы, которых нет на месте; недостачу — целыми единицами.
	for _, e in w:each({ "Owner", "Inventory" }) do
		if w:get(e, "Owner").player ~= player then
			continue
		end
		local site = w:has(e, "Site")
		if not site and not w:has(e, "Producer") then
			continue
		end
		-- Выключенному производству материалы не везут.
		if not site and (not logistics.isReady(w, player, e) or w:has(e, "Converting") or w:has(e, "Off")) then
			continue
		end
		for good, amount in logistics.missing(w, e) do
			need(e, good, math.ceil(amount - 1e-6), if site then logistics.PRIORITY.site else logistics.PRIORITY.production, "zone")
		end
	end
	-- Переработка: своя руда из своих шахт, в какой бы зоне они ни стояли; больше буфера не просит.
	for _, e in w:each({ "Building", "Inventory", "Owner" }) do
		local ore = dataOf(w, e).refines
		if not ore or not logistics.isReady(w, player, e) or w:has(e, "Converting") or w:has(e, "Off") then
			continue
		end
		local room = goods.room(w:get(e, "Inventory"), ore)
		if room > 0 then
			need(e, ore, room, logistics.PRIORITY.refine, "mines")
		end
	end
	-- Лаборатории: сырьё нынешней темы и головной, по LAB_STOCK каждого, но не больше своей доли того, что осталось
	-- потратить. Руду — из своих шахт, где бы они ни стояли.
	local labs = {}
	for _, e in w:each({ "Building", "Owner", "Inventory" }) do
		if dataOf(w, e).researches and logistics.isReady(w, player, e) and not w:has(e, "Off") then
			table.insert(labs, e)
		end
	end
	if #labs > 0 then
		for good, left in research.needs(w, player) do
			local share = math.min(logistics.LAB_STOCK, math.ceil(left / #labs - 1e-6))
			for _, lab in labs do
				need(lab, good, share - goods.amount(w:get(lab, "Inventory"), good), logistics.PRIORITY.production, if goods.isOre(w, good) then "mines" else "zone")
			end
		end
	end
	-- Включённые цеха: сырьё рецепта, сколько его держат про запас.
	for _, e in w:each({ "Assembly", "Inventory", "Owner" }) do
		local assembly = w:get(e, "Assembly")
		local product = w.protos.goods[assembly.recipe]
		if not assembly.on or not product or not logistics.isReady(w, player, e) then
			continue
		end
		local stock = w:get(e, "Inventory")
		for good, amount in product.data.recipe do
			need(e, good, amount * logistics.STOCKED_CYCLES - goods.amount(stock, good), logistics.PRIORITY.production, "zone")
		end
	end
	table.sort(requests, function(a, b)
		return a.priority > b.priority
	end)
	return requests
end

-- Не подъехать грузовикам к зданию: отметка Unreachable ещё действует.
function logistics.unreachable(w, e: number): boolean
	local mark = w:get(e, "Unreachable")
	return mark ~= nil and mark["until"] > w.tick
end

-- Сколько груза ещё поместится на склад для этого грузовика: место за вычетом того, что туда уже везут (spaceFor).
function logistics.space(w, to: number, good: string, flows: Flows): number
	local stock = w:get(to, "Inventory")
	if not stock then
		return 0
	end
	local incoming = flows.incoming[to]
	return goods.room(stock, good) - (if incoming then incoming[good] or 0 else 0)
end

-- Своё хранилище, куда грузовик отвезёт груз (storeFor): самое пустое по этому грузу с учётом едущего, из равных —
-- ближайшее. Нет места нигде — nil.
function logistics.storeFor(w, truck: number, good: string, except: number?): number?
	local player = w:get(truck, "Owner").player
	local flows = logistics.flows(w, truck)
	local best, bestFill, bestDistance = nil, math.huge, math.huge
	for _, e in w:each({ "Inventory", "Building" }) do
		if e == except or not logistics.isStore(w, e) or not logistics.isReady(w, player, e) or w:has(e, "Converting") or logistics.unreachable(w, e) then
			continue
		end
		local space = logistics.space(w, e, good, flows)
		if space <= EPSILON then
			continue
		end
		local stock = w:get(e, "Inventory")
		local holds = math.min(stock.limits[good] or stock.capacity, stock.capacity)
		-- Доля занятого — до десятых: почти равные считаются равными, и решает близость.
		local fill = math.floor((1 - space / holds) * 10 + 0.5)
		local far = distance(w, truck, e)
		if fill < bestFill or (fill == bestFill and far < bestDistance) then
			best, bestFill, bestDistance = e, fill, far
		end
	end
	return best
end

-- Ближайшая к грузовику своя переработка этой руды с местом под неё, не из сети skip (refineryFor).
function logistics.refineryFor(w, truck: number, ore: string, except: number?, skip: any?): number?
	local player = w:get(truck, "Owner").player
	local flows = logistics.flows(w, truck)
	local best, bestDistance = nil, math.huge
	for _, e in w:each({ "Inventory", "Building" }) do
		if e == except or dataOf(w, e).refines ~= ore or not logistics.isReady(w, player, e) or w:has(e, "Converting") or w:has(e, "Off") then
			continue
		end
		if logistics.space(w, e, ore, flows) <= EPSILON or logistics.unreachable(w, e) then
			continue
		end
		if skip and logistics.networkOf(w, e) == skip then
			continue
		end
		local far = distance(w, truck, e)
		if far < bestDistance then
			best, bestDistance = e, far
		end
	end
	return best
end

-- Куда везти груз без заявки (deliveryFor): готовое — в хранилище, руду — на переработку.
function logistics.deliveryFor(w, truck: number, good: string, except: number?): number?
	if goods.isOre(w, good) then
		return logistics.refineryFor(w, truck, good, except)
	end
	return logistics.storeFor(w, truck, good, except)
end

-- Годится ли склад, чтобы выгрузить в него груз (acceptsDelivery): своё хранилище с местом или переработка с местом
-- под свою руду.
function logistics.accepts(w, player: number, to: number, good: string): boolean
	local stock = w:alive(to) and w:get(to, "Inventory")
	if not stock or goods.room(stock, good) <= EPSILON then
		return false
	end
	-- Стройка — только свои материалы.
	if w:has(to, "Site") then
		local owner = w:get(to, "Owner")
		return owner ~= nil and owner.player == player and (logistics.materials(w, to) or {})[good] ~= nil
	end
	if not logistics.isReady(w, player, to) or w:has(to, "Converting") then
		return false
	end
	if logistics.isStore(w, to) then
		return true
	end
	if (logistics.materials(w, to) or {})[good] then
		return true
	end
	if table.find(logistics.inputs(w, to), good) then
		return true
	end
	-- Лаборатория — сырьё своей нынешней темы.
	if dataOf(w, to).researches and research.needs(w, player)[good] then
		return true
	end
	return dataOf(w, to).refines == good
end

-- Можно ли забирать груз со склада (offersPickup): свой готовый склад, где он есть.
function logistics.offersPickup(w, player: number, from: number, good: string): boolean
	return logistics.isReady(w, player, from) and logistics.spare(w, from, good) > EPSILON
end

-- Дальше этого от стройки строитель за материалом не едет, меньше этого не возит (FETCH_REACH, MIN_FETCH).
logistics.FETCH_REACH = 40
logistics.MIN_FETCH = 0.5

-- Где строителю взять материал для стройки (fetchSource): ближайшее к нему своё готовое здание, которое отдаёт
-- недостающее сверх того, что уже едет, не дальше FETCH_REACH от стройки. nil — брать негде или везти нечего.
function logistics.fetchSource(w, builder: number, site: number, flows: Flows): { from: number, resource: string, amount: number }?
	local owner = w:get(builder, "Owner")
	local cargo = w:get(builder, "Inventory")
	local at = w:get(builder, "Position")
	if not owner or not cargo or not at or not w:has(site, "Site") then
		return nil
	end
	local coming = flows.incoming[site] or {}
	local short = {}
	local any = false
	for good, amount in logistics.missing(w, site) do
		local left = amount - (coming[good] or 0)
		if left >= logistics.MIN_FETCH then
			short[good] = left
			any = true
		end
	end
	if not any then
		return nil
	end
	local to = w:get(site, "Position")
	local best, bestDistance = nil, math.huge
	for _, e in w:each({ "Building", "Owner", "Inventory" }) do
		if e == site or w:has(e, "Site") or w:get(e, "Owner").player ~= owner.player then
			continue
		end
		local there = w:get(e, "Position")
		if math.sqrt((there.x - to.x) ^ 2 + (there.y - to.y) ^ 2) > logistics.FETCH_REACH then
			continue
		end
		local distance = math.sqrt((there.x - at.x) ^ 2 + (there.y - at.y) ^ 2)
		if distance >= bestDistance then
			continue
		end
		local offers = logistics.offers(w, e)
		for _, good in goods.names(w) do
			local need = short[good]
			if not need or not table.find(offers, good) then
				continue
			end
			local amount = math.min(need, logistics.available(w, flows, e, good), goods.room(cargo, good))
			if amount >= logistics.MIN_FETCH then
				best, bestDistance = { from = e, resource = good, amount = amount }, distance
				break
			end
		end
	end
	return best
end

-- Может ли юнит возить материалы: ремонтник с кузовом и лучом (canFetch).
function logistics.canFetch(w, e: number): boolean
	return w:has(e, "Repair") and w:has(e, "Inventory") and w:has(e, "Beam") and w:has(e, "Unit")
end

-- Будет ли строитель возить материал на свою стройку, а не искать другую работу (willFetch).
function logistics.willFetch(w, builder: number, site: number): boolean
	return logistics.canFetch(w, builder) and logistics.fetchSource(w, builder, site, logistics.flows(w)) ~= nil
end

-- Запас каждого готового груза в хранилищах игрока и сколько они вмещают (stockOf): для полосы.
function logistics.stockOf(w, player: number): ({ [string]: number }, number)
	local items, capacity = {}, 0
	for _, e in w:each({ "Inventory", "Building" }) do
		if logistics.isStore(w, e) and logistics.isReady(w, player, e) then
			local stock = w:get(e, "Inventory")
			capacity += stock.capacity
			for good, amount in stock.items do
				items[good] = (items[good] or 0) + amount
			end
		end
	end
	return items, capacity
end

return logistics
