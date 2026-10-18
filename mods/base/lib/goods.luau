--!strict
-- Груз — перенос resources.ts, inventory.ts (склад) и goodIcons.ts (значок). Вид груза — раздел goods/: руда (её даёт
-- шахта, идёт только в переработку), ресурс (выходит с переработки: продают, строят, делают юнитов) и изделие (собирает
-- цех из ресурсов). Ресурсы и изделия вместе — готовое: оно лежит в хранилищах. Годится и хосту (ctx), и клиенту (c).
--
-- Склад (Inventory) — items: груз → сколько; capacity — сколько всего; accepts — что сюда кладут (пусто — всё);
-- limits — сколько каждого самое большее; reserve — сколько хранилище не выдаёт никому, кроме продажи.

local goods = {}

-- Заметно меньше этого — пусто: доли копятся с погрешностью.
goods.EPSILON = 1e-9

-- Все грузы по порядку GOODS: ресурсы, изделия, руда.
local cache = setmetatable({}, { __mode = "k" }) :: { [any]: { any } }

function goods.list(w): { any }
	local found = cache[w.protos]
	if found then
		return found
	end
	found = {}
	for _, kind in w.protos.goods or {} do
		table.insert(found, kind)
	end
	table.sort(found, function(a, b)
		return a.data.order < b.data.order
	end)
	cache[w.protos] = found
	return found
end

-- Имена грузов по порядку.
function goods.names(w): { string }
	local names = {}
	for _, kind in goods.list(w) do
		table.insert(names, kind.name)
	end
	return names
end

function goods.isOre(w, good: string): boolean
	local kind = w.protos.goods[good]
	return kind ~= nil and kind.data.kind == "ore"
end

function goods.isProduct(w, good: string): boolean
	local kind = w.protos.goods[good]
	return kind ~= nil and kind.data.kind == "product"
end

-- Готовое: ресурс или изделие.
function goods.isWare(w, good: string): boolean
	local kind = w.protos.goods[good]
	return kind ~= nil and kind.data.kind ~= "ore"
end

-- Что выходит из руды на переработке (resourceOf).
function goods.resourceOf(w, ore: string): string?
	local kind = w.protos.goods[ore]
	return kind and kind.data.resource
end

-- Чем добывают ресурс (ORE_OF): металл — металлической рудой.
function goods.oreOf(w, resource: string): string?
	for _, kind in goods.list(w) do
		if kind.data.resource == resource then
			return kind.name
		end
	end
	return nil
end

export type Stock = { items: { [string]: number }, capacity: number, accepts: { string }, limits: { [string]: number }, reserve: number }

-- Сколько этого груза на складе (amountOf).
function goods.amount(stock: Stock, good: string): number
	return stock.items[good] or 0
end

-- Сколько всего на складе, любого груза вместе (loadOf).
function goods.load(stock: Stock): number
	local sum = 0
	for _, amount in stock.items do
		sum += amount
	end
	return sum
end

-- Сколько этого груза ещё поместится (roomFor): ноль — полон, такое сюда не кладут или его предел набран.
function goods.room(stock: Stock, good: string): number
	if #stock.accepts > 0 and not table.find(stock.accepts, good) then
		return 0
	end
	local limit = stock.limits[good]
	local left = if limit == nil then math.huge else limit - goods.amount(stock, good)
	return math.max(0, math.min(left, stock.capacity - goods.load(stock)))
end

-- Кладёт до amount, сколько поместится (put); возвращает положенное.
function goods.put(stock: Stock, good: string, amount: number): number
	local moved = math.max(0, math.min(amount, goods.room(stock, good)))
	if moved > 0 then
		stock.items[good] = goods.amount(stock, good) + moved
	end
	return moved
end

-- Забирает до amount, сколько есть (take); возвращает забранное.
function goods.take(stock: Stock, good: string, amount: number): number
	local moved = math.max(0, math.min(amount, goods.amount(stock, good)))
	if moved > 0 then
		stock.items[good] = goods.amount(stock, good) - moved
	end
	return moved
end

-- Склад по данным вида (equipStorage): inventory — объём, accepts, limits.
function goods.stock(data): Stock?
	if not data.inventory then
		return nil
	end
	return { items = {}, capacity = data.inventory, accepts = data.accepts or {}, limits = data.limits or {}, reserve = 0 }
end

-- Книга системы: обёртка над ctx, у которой компоненты из names читаются один раз и дальше меняются на месте — как
-- объекты в TS: ctx:set откладывается до конца системы, а грузовики меняют склады друг друга в одном тике.
-- book:flush() пишет прочитанное разом. Остальное — как у ctx.
function goods.book(ctx, names: { string })
	local cached: { [string]: { [number]: any } } = {}
	for _, name in names do
		cached[name] = {}
	end
	local methods: { [string]: any } = {}
	local book = {}
	function methods.get(_, e: number, component: string)
		local store = cached[component]
		if not store then
			return ctx:get(e, component)
		end
		local value = store[e]
		if value == nil then
			value = ctx:get(e, component) or false
			store[e] = value
		end
		return if value == false then nil else value
	end
	function methods.set(_, e: number, component: string, values)
		local store = cached[component]
		local value = store and methods.get(book, e, component)
		if value then
			for key, field in values do
				value[key] = field
			end
		else
			ctx:set(e, component, values)
		end
	end
	function methods.remove(_, e: number, component: string)
		local store = cached[component]
		if store then
			store[e] = false
		end
		ctx:remove(e, component)
	end
	function methods.flush()
		for component, store in cached do
			for e, value in store do
				if value and ctx:alive(e) and ctx:has(e, component) then
					ctx:set(e, component, value)
				end
			end
			table.clear(store)
		end
	end
	return setmetatable(book, {
		__index = function(_, key: string)
			local method = methods[key]
			if method then
				return method
			end
			local value = ctx[key]
			if type(value) == "function" then
				local wrapped = function(_, ...)
					return value(ctx, ...)
				end
				methods[key] = wrapped
				return wrapped
			end
			return value
		end,
	})
end

-- Значки грузов: маски 10 × 10 (goodIcons.ts). o — контур, l — светлый тон, b — основной, d — тёмный, x — вкрапление
-- цвета ресурса у руды.
local MASKS = {
	metal = { "..........", "..........", "..oooooo..", "..ollllo..", ".olbbbbdo.", ".obbbbbdo.", "obbbbbbddo", "oooooooooo", "..........", ".........." },
	silicon = { "....oo....", "...olbo...", "..olbbdo..", "..olbbdo..", "..olbbdo..", "..olbbdo..", "..olbbdo..", "...obdo...", "....oo....", ".........." },
	fuel = { "..........", "...ooo....", "..oo.oooo.", ".olllllbo.", ".olbbbbdo.", ".olbddbdo.", ".olbbbbdo.", ".olbbbbdo.", ".oddddddo.", ".oooooooo." },
	kharite = { "..........", "..oooooo..", ".olllbbbo.", "oolllbbddo", ".olbbbbdo.", "..olbbdo..", "...obdo...", "....oo....", "..........", ".........." },
	lithium = { "..........", "...oooo...", "..olllbo..", "..oddddo..", "..olllbo..", "..oddddo..", "..olllbo..", "..obbbdo..", "..oddddo..", "...oooo..." },
	uranium = { "...oooo...", "..olddlo..", ".ollddllo.", "obllddllbo", "obbbllbbbo", "oddbllbddo", "odddbbdddo", ".oddbbddo.", "..obbbbo..", "...oooo..." },
	rods = { ".oo.oo.oo.", ".ol.ol.ol.", ".ob.ob.ob.", ".ob.ob.ob.", ".ob.ob.ob.", ".ob.ob.ob.", "oooooooooo", "odddddddd.", ".ob.ob.ob.", ".od.od.od." },
	blocks = { "..........", "..........", "oooooooooo", "olbbdolbbd", "oddddodddd", "oooooooooo", "olbdolbbdo", "oddoddddoo", "oooooooooo", ".........." },
	ammo = { "..o....o..", ".olo..olo.", ".olo..olo.", ".ooo..ooo.", ".olo..olo.", ".obo..obo.", ".obo..obo.", ".odo..odo.", ".ooo..ooo.", ".........." },
	parts = { "..........", "..o.o.o...", ".ooooooo..", "oolllllboo", ".olbbbbdo.", "oolbbbbdoo", ".oddddddo.", ".ooooooo..", "..o.o.o...", ".........." },
	ore = { "..........", "...oooo...", "..odbbdo..", ".odbxbbdo.", ".obbbbxbo.", "odbxbbbbdo", "obbbbxbbdo", "oddbbbddo.", ".oooooooo.", ".........." },
}
-- Камень руды.
local ROCK = 0x7a6f62

-- Цвет, сдвинутый к белому (amount > 0) или к чёрному (amount < 0).
local function shade(color: number, amount: number): number
	local function channel(shift: number): number
		local value = bit32.band(bit32.rshift(color, shift), 255)
		return math.floor((if amount > 0 then value + (255 - value) * amount else value * (1 + amount)) + 0.5)
	end
	return channel(16) * 0x10000 + channel(8) * 0x100 + channel(0)
end

-- Облик груза: значок 10 × 10 (paintGood); mask — маска (у руды — "ore"), color — цвет, vein — цвет вкраплений.
function goods.look(mask: string, color: number, vein: number?)
	local ore = mask == "ore"
	local base = if ore then ROCK else color
	local tones = {
		o = shade(base, -0.7),
		l = shade(base, 0.4),
		b = shade(base, 0),
		d = shade(base, -0.4),
		x = shade(if ore then vein or color else base, 0.1),
	}
	local function draw(g)
		for y, row in MASKS[mask] do
			for x = 1, #row do
				local tone = tones[string.sub(row, x, x)]
				if tone then
					g:set(x - 1, y - 1, tone)
				end
			end
		end
	end
	return {
		size = 10,
		origin = { 0, 0 },
		layer = "ground",
		shadow = false,
		draw = draw,
		portrait = { size = 10, origin = { 0, 0 }, draw = draw },
	}
end

return goods
