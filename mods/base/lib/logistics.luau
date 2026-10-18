--!strict
-- Зональные заявки — перенос logistics.ts, общий хосту (ctx) и клиенту (c). Всё, что потребляет груз, само заказывает
-- его у своей зоны: переработка — руду из своих шахт, где бы они ни стояли. Свободные грузовики берут самую важную
-- заявку и везут груз; когда заявок нет, развозят готовое из переработки по хранилищам. Руду без переработки никто не
-- возит: она копится в шахте. Как ездят грузовики — mechanics/hauling.
--
-- Пока нет: материалов стройке и производству, цехов, лабораторий, патронов турелям, станций запроса, продажи, дропов,
-- маршрутов и ручных приказов — их заявки придут с их механиками; трубы ещё не везут груз (В5), поэтому грузовик
-- везёт и внутри сети.

local goods = require("lib/goods")
local kinds = require("lib/kinds")

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

-- Что сейчас везут грузовики (flowsOf): набравший везёт то, что в кузове; ещё не набравший обещал привезти и забрать
-- столько, сколько в его работе. except — грузовик, которого не считать.
function logistics.flows(w, except: number?): Flows
	local flows: Flows = { incoming = {}, outgoing = {} }
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

-- Что здание отдаёт по заявкам (offersOf): хранилище и переработка — готовое, шахта — свою руду.
function logistics.offers(w, e: number): { string }
	if not w:has(e, "Building") or w:has(e, "Site") then
		return {}
	end
	local data = dataOf(w, e)
	if data.stores or data.refines then
		local wares = {}
		for _, kind in goods.list(w) do
			if kind.data.kind ~= "ore" then
				table.insert(wares, kind.name)
			end
		end
		return wares
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
		end
		networkIndex[key] = found
	end
	return found.of[e]
end

export type Request = { to: number, resource: string, amount: number, priority: number, source: string }

-- Заявки игрока (requestsOf): что, куда и сколько везти, с учётом того, что уже едет; важные — первыми.
function logistics.requests(w, player: number, flows: Flows): { Request }
	local requests: { Request } = {}
	local function need(to: number, good: string, amount: number, priority: number, source: string)
		local incoming = flows.incoming[to]
		local left = amount - (if incoming then incoming[good] or 0 else 0)
		if left >= logistics.MIN_JOB then
			table.insert(requests, { to = to, resource = good, amount = left, priority = priority, source = source })
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
	if not stock or not logistics.isReady(w, player, to) or w:has(to, "Converting") or goods.room(stock, good) <= EPSILON then
		return false
	end
	if logistics.isStore(w, to) then
		return true
	end
	return dataOf(w, to).refines == good
end

-- Можно ли забирать груз со склада (offersPickup): свой готовый склад, где он есть.
function logistics.offersPickup(w, player: number, from: number, good: string): boolean
	return logistics.isReady(w, player, from) and logistics.spare(w, from, good) > EPSILON
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
