--!strict
-- Доставка по трубам. Внутри сети груз ходит пачками: заказчик (стройка, производство, переработка, цех, лаборатория)
-- берёт его у ближайшего по трубам поставщика своей сети, а переработка, цеха и лаборатории сами развозят готовое по
-- хранилищам сети. Пачка — до batch единиц одного груза, идёт тайл за тик; следующую по тому же маршруту отправляют
-- после прихода. Труба ничего не держит: маршрутов сколько угодно. Перерезали трубу — пачки на ней пропадают. Пути по
-- сети считает движок (ctx:distances, ctx:route).

local goods = require("lib/goods")
local logistics = require("lib/logistics")

local mechanic = {}

local EPSILON = goods.EPSILON

mechanic.data = {
	-- Сколько единиц самое большее идёт одной пачкой и меньше скольких не шлют, если заказчику нужно больше.
	batch = 5,
	minBatch = 1,
}

mechanic.components = {
	-- Пачка в трубах: от from к to, груз и сколько, тики отправки и прихода; push — развоз готового (маршрут занят
	-- отправителем), иначе заказ (занят получателем); path — узлы, где путь поворачивает, с началом и концом.
	Batch = { from = -1, to = -1, resource = "", amount = 0, sent = 0, arrive = 0, push = false, path = {} },
}

-- Цел ли путь пачки: все его узлы в одной сети с получателем (intact).
local function intact(w, path: { number }, to: number): boolean
	local network = logistics.networkOf(w, to)
	if not network then
		return false
	end
	for i = 2, #path do
		if logistics.networkOf(w, path[i]) ~= network then
			return false
		end
	end
	return true
end

-- Пачка пришла: груз ложится на склад получателя; не поместилось — обратно отправителю или в хранилище сети (deliver).
local function deliver(w, batch)
	local to = batch.to
	if not w:alive(to) or not intact(w, batch.path, to) then
		return
	end
	local left = batch.amount
	local stock = w:get(to, "Inventory")
	if stock then
		left -= goods.put(stock, batch.resource, left)
	end
	if left <= EPSILON then
		return
	end
	local network = logistics.networkOf(w, to)
	local others = { batch.from }
	for _, member in network.members do
		table.insert(others, member)
	end
	for _, other in others do
		if left <= EPSILON then
			break
		end
		if not w:alive(other) or logistics.networkOf(w, other) ~= network or (other ~= batch.from and not logistics.isStore(w, other)) then
			continue
		end
		local held = w:get(other, "Inventory")
		if held then
			left -= goods.put(held, batch.resource, left)
		end
	end
end

-- Отправляет пачку: груз уходит со склада from сразу и придёт на склад to через столько тиков, сколько тайлов пути.
local function send(w, player: number, from: number, to: number, good: string, amount: number, length: number, push: boolean)
	local taken = goods.take(w:get(from, "Inventory"), good, amount)
	if taken <= EPSILON then
		return
	end
	local tick = w.tick
	w:spawn(nil, {
		Batch = { from = from, to = to, resource = good, amount = taken, sent = tick, arrive = tick + math.max(1, math.floor(length + 0.5)), push = push, path = w:route(from, to) },
		Owner = { player = player },
	})
end

-- Развоз готового: переработка, цеха и лаборатории отправляют его в хранилища своей сети — по пачке, когда накопилось
-- на пачку, а остатки — сколько есть. Хранилище — самое пустое по грузу с учётом едущего, из равных — ближайшее.
local function pushOutlets(w, player: number, network, busy: { [string]: boolean }, incoming)
	local stores = {}
	for _, member in network.members do
		if logistics.isStore(w, member) then
			table.insert(stores, member)
		end
	end
	if #stores == 0 then
		return
	end
	local d = mechanic.data
	for _, source in network.members do
		local data = logistics.dataOf(w, source)
		if not data.refines and not data.assembles and not data.researches and not data.trades then
			continue
		end
		local stock = w:get(source, "Inventory")
		if not stock then
			continue
		end
		for _, good in logistics.offers(w, source) do
			local key = ">" .. source .. ":" .. good
			if busy[key] then
				continue
			end
			local available = logistics.spare(w, source, good)
			local leftover = data.researches or data.trades or (data.assembles and not goods.isProduct(w, good)) or (data.refines and goods.amount(stock, data.refines) <= EPSILON)
			if available < (if leftover then EPSILON else d.batch) then
				continue
			end
			local routes = w:distances(source)
			if not routes then
				continue
			end
			local best, bestFill, bestLength, bestSpace = nil, math.huge, math.huge, 0
			for _, store in stores do
				local length = routes[store]
				if not length then
					continue
				end
				local held = w:get(store, "Inventory")
				local coming = incoming[store]
				local space = goods.room(held, good) - (if coming then coming[good] or 0 else 0)
				if space <= EPSILON then
					continue
				end
				local holds = math.min(held.limits[good] or held.capacity, held.capacity)
				local fill = math.floor((1 - space / holds) * 10 + 0.5)
				if fill > bestFill or (fill == bestFill and length >= bestLength) then
					continue
				end
				best, bestFill, bestLength, bestSpace = store, fill, length, space
			end
			if best then
				local amount = math.min(d.batch, available, bestSpace)
				busy[key] = true
				logistics.add(incoming, best, good, amount)
				send(w, player, source, best, good, amount, bestLength, true)
			end
		end
	end
end

mechanic.systems = {
	-- После стройки и до грузовиков: что идёт по трубам, грузовики уже не везут.
	pipes = {
		query = { "Batch" },
		after = { "construct" },
		before = { "haul" },
		run = function(_, ctx)
			local w = goods.book(ctx, { "Inventory" })
			local tick = ctx.tick
			-- Занятые маршруты: заказ — получатель и груз, развоз — отправитель и груз.
			local busy = {}
			for _, e in ctx:each({ "Batch" }) do
				local batch = ctx:get(e, "Batch")
				if tick > batch.arrive then
					ctx:destroy(e)
					continue
				end
				busy[if batch.push then ">" .. batch.from .. ":" .. batch.resource else "<" .. batch.to .. ":" .. batch.resource] = true
				if tick == batch.arrive then
					deliver(w, batch)
				end
			end
			local d = mechanic.data
			local flows = logistics.flows(w)
			local players = {}
			for _, network in ctx:networks() do
				if network.player ~= 0 then
					players[network.player] = true
				end
			end
			for player in players do
				for _, request in logistics.requests(w, player, flows) do
					local key = "<" .. request.to .. ":" .. request.resource
					local network = logistics.networkOf(w, request.to)
					if busy[key] or not network then
						continue
					end
					local routes = ctx:distances(request.to)
					if not routes then
						continue
					end
					local best, bestLength, bestAmount = nil, math.huge, 0
					for _, source in network.members do
						local length = routes[source]
						if source == request.to or not length or length >= bestLength then
							continue
						end
						if not table.find(logistics.offers(w, source), request.resource) then
							continue
						end
						local available = logistics.given(w, source, request.resource, request.sale)
						if available < math.min(request.amount, d.minBatch) - EPSILON then
							continue
						end
						best, bestLength, bestAmount = source, length, math.min(d.batch, request.amount, available)
					end
					if best then
						busy[key] = true
						send(w, player, best, request.to, request.resource, bestAmount, bestLength, false)
					end
				end
				for _, network in ctx:networks() do
					if network.player == player then
						pushOutlets(w, player, network, busy, flows.incoming)
					end
				end
			end
			w:flush()
		end,
	},
}

return mechanic
