--!strict
-- Готовые базы — помощники сценок витрины (showcase.ts) и песочницы (sandbox.ts): ставят здания сразу, без стройки,
-- соединяют базу трубами (connectAll, pipeRoute в piping.ts), выводят отряды и открывают исследования. Только хосту:
-- правки мира применяются сразу (ctx:flush), чтобы следующее здание видело, что место занято.

local placement = require("lib/placement")
local kinds = require("lib/kinds")
local battle = require("lib/battle")

local scenery = {}

-- Дальше скольких тайлов трасса трубы не ищется (ROUTE_REACH).
scenery.ROUTE_REACH = 16

local SIDES = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

-- Тайлы вокруг (x, y) по расширяющимся квадратам, до radius включительно (around): x, y подряд.
function scenery.around(x: number, y: number, radius: number): { number }
	local tiles = {}
	for ring = 0, radius do
		for dy = -ring, ring do
			for dx = -ring, ring do
				if math.max(math.abs(dx), math.abs(dy)) == ring then
					table.insert(tiles, x + dx)
					table.insert(tiles, y + dy)
				end
			end
		end
	end
	return tiles
end

-- Можно ли поставить здание вида name с левым верхним тайлом (x, y) и проходом gap вокруг (canPlace).
function scenery.canPlace(ctx, name: string, x: number, y: number, gap: number?): boolean
	local kind = ctx.protos.buildings[name]
	return kind ~= nil and placement.canPlace(ctx, kind, x, y, gap)
end

-- Ставит готовое здание вида name с левым верхним тайлом (x, y) игроку player (placeBuilding) — сразу.
function scenery.place(ctx, name: string, x: number, y: number, player: number): number
	local kind = ctx.protos.buildings[name]
	local e = ctx:spawn(kind, {
		Position = { x = placement.middle(x, kind.data.width), y = placement.middle(y, kind.data.height) },
		Owner = { player = player },
	})
	ctx:flush()
	return e
end

-- Ближайшее к началу мира место, где встаёт здание name с проходом gap вокруг (openSpot); nil — нет.
function scenery.openSpot(ctx, name: string, gap: number, radius: number?): { x: number, y: number }?
	local tiles = scenery.around(0, 0, radius or 40)
	for i = 1, #tiles - 1, 2 do
		if scenery.canPlace(ctx, name, tiles[i], tiles[i + 1], gap) then
			return { x = tiles[i], y = tiles[i + 1] }
		end
	end
	return nil
end

-- Отряд из видов names игрока player на свободных тайлах у (x, y), не ближе from (spawnGroup); бойцы агрессивны.
function scenery.spawnGroup(ctx, names: { string }, player: number, x: number, y: number, from: number?): { number }
	local tiles = ctx:free_tiles(math.floor(x), math.floor(y), #names, from or 0)
	local units = battle.spawn(ctx, names, player, tiles)
	ctx:flush()
	return units
end

-- Даёт игроку кредиты сразу.
function scenery.addCredits(ctx, player: number, amount: number)
	for _, e in ctx:each({ "Player" }) do
		local state = ctx:get(e, "Player")
		if state.id == player then
			ctx:set(e, "Player", { credits = state.credits + amount })
		end
	end
	ctx:flush()
end

-- Открывает игроку все исследования (grantResearch): сценка их не показывает.
function scenery.grantResearch(ctx, player: number)
	local topics = {}
	for name in ctx.protos.research do
		table.insert(topics, name)
	end
	table.sort(topics)
	for _, e in ctx:each({ "Player" }) do
		if ctx:get(e, "Player").id == player then
			ctx:set(e, "Player", { research = topics })
		end
	end
	ctx:flush()
end

-- Сеть каждой сущности по ctx:networks: снимок на один поиск трассы.
local function networkIndex(ctx): { [number]: any }
	local index = {}
	for _, network in ctx:networks() do
		for _, member in network.members do
			index[member] = network
		end
	end
	return index
end

-- Трасса наземной трубы от основания (x, y, width, height) до узла сети игрока (pipeRoute): тайлы x, y подряд, от
-- основания к сети. Пусто — к основанию уже подходит своя труба; nil — сети ближе ROUTE_REACH нет. Узел — готовое своё
-- здание сети; joins — какую сеть годится брать.
function scenery.pipeRoute(ctx, player: number, x: number, y: number, width: number, height: number, joins: (any) -> boolean): { number }?
	local function inside(tx: number, ty: number): boolean
		return tx >= x and tx < x + width and ty >= y and ty < y + height
	end
	local index = networkIndex(ctx)
	local function node(tx: number, ty: number, pipeOnly: boolean): boolean
		if inside(tx, ty) then
			return false
		end
		local other = ctx:occupant(tx, ty)
		local owner = other and ctx:get(other, "Owner")
		if not other or not owner or owner.player ~= player or ctx:has(other, "Site") then
			return false
		end
		local kind = kinds.of(ctx, other)
		if pipeOnly and not (kind and kind.data.pipe) then
			return false
		end
		local network = index[other]
		return network ~= nil and joins(network)
	end
	for tx = x, x + width - 1 do
		if node(tx, y - 1, true) or node(tx, y + height, true) then
			return {}
		end
	end
	for ty = y, y + height - 1 do
		if node(x - 1, ty, true) or node(x + width, ty, true) then
			return {}
		end
	end
	local function free(tx: number, ty: number): boolean
		return not inside(tx, ty) and scenery.canPlace(ctx, "pipe", tx, ty)
	end
	local previous: { [string]: number } = {}
	local queue: { number } = {}
	local function start(tx: number, ty: number)
		local key = tx .. ":" .. ty
		if previous[key] or not free(tx, ty) then
			return
		end
		previous[key] = -1
		table.move({ tx, ty, 1 }, 1, 3, #queue + 1, queue)
	end
	for tx = x, x + width - 1 do
		start(tx, y - 1)
		start(tx, y + height)
	end
	for ty = y, y + height - 1 do
		start(x - 1, ty)
		start(x + width, ty)
	end
	local at = 1
	while at <= #queue do
		local tx, ty, length = queue[at], queue[at + 1], queue[at + 2]
		for _, d in SIDES do
			if node(tx + d[1], ty + d[2], false) then
				-- Назад по цепочке — от сети к основанию; трасса нужна в обратном порядке.
				local back = {}
				local i = at
				while i >= 1 do
					table.insert(back, queue[i])
					table.insert(back, queue[i + 1])
					i = previous[queue[i] .. ":" .. queue[i + 1]]
				end
				local tiles = {}
				for j = #back - 1, 1, -2 do
					table.insert(tiles, back[j])
					table.insert(tiles, back[j + 1])
				end
				return tiles
			end
		end
		if length < scenery.ROUTE_REACH then
			for _, d in SIDES do
				local nx, ny = tx + d[1], ty + d[2]
				local key = nx .. ":" .. ny
				if not previous[key] and free(nx, ny) then
					previous[key] = at
					table.move({ nx, ny, length + 1 }, 1, 3, #queue + 1, queue)
				end
			end
		end
		at += 3
	end
	return nil
end

-- Соединяет трубами все сети игрока с первой — с главным зданием (connectAll): готовые трубы сразу, без стройки. Сеть,
-- до которой трассы не нашлось, остаётся отдельной.
function scenery.connectAll(ctx, player: number)
	local joined = true
	while joined do
		joined = false
		local own = {}
		for _, network in ctx:networks() do
			if network.player == player then
				table.insert(own, network)
			end
		end
		if #own < 2 then
			return
		end
		local main = own[1]
		for i = 2, #own do
			local network = own[i]
			local entity = network.members[1]
			for _, member in network.members do
				local kind = kinds.of(ctx, member)
				if kind and not kind.data.pipe and ctx:has(member, "Building") then
					entity = member
					break
				end
			end
			local kind = kinds.of(ctx, entity)
			local at = ctx:get(entity, "Position")
			if not kind or not at then
				continue
			end
			local width, height = kind.data.width, kind.data.height
			local tiles = scenery.pipeRoute(ctx, player, placement.left(at.x, width), placement.left(at.y, height), width, height, function(other)
				return other.members[1] == main.members[1]
			end)
			if tiles and #tiles > 0 then
				for j = 1, #tiles - 1, 2 do
					scenery.place(ctx, "pipe", tiles[j], tiles[j + 1], player)
				end
				joined = true
				break
			end
		end
	end
end

return scenery
