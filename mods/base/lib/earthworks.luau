--!strict
-- Землеройные работы — перенос earthworks.ts, общий хосту (ctx) и клиенту (c): строители срывают горы и сглаживают
-- обрывы. Гору срывают целиком — она рисуется от вершины, и кусок горы остался бы обрубком; на её месте — скала того
-- же яруса, что вокруг. Обрыв сглаживают по тайлу кромки: кромка становится пологой, и подножие под ней — проездом
-- для техники. Работа — сущность с Dig, её строят строители, как покрытие; плата — сразу при заказе. Правку другие
-- видят, только когда увидят её место (память земли движка). Открывает их исследование earthworks.
--
-- Тайл — хранимые байты (w:tile): вид, биом, байт вершины, рельеф (ярус в двух младших битах, CLIFF_BIT, барханы с
-- DUNE_SHIFT). У клиента это земля, какой её знает свой игрок.

local construction = require("lib/construction")
local zones = require("lib/zones")

local earthworks = {}

earthworks.KINDS = { "peak", "cliff" }
-- Цена срытия горы за каждый её тайл и сглаживания тайла кромки (PEAK_COST, CLIFF_COST).
earthworks.PEAK_COST = 40
earthworks.CLIFF_COST = 25
-- Какое исследование открывает землеройные работы (DIG_RESEARCH).
earthworks.RESEARCH = "earthworks"
earthworks.TITLES = { peak = "Срыть гору", cliff = "Сгладить обрыв" }

local ROCK, MOUNTAIN = 2, 3
local CLIFF_BIT = 4
local DUNE_SHIFT = 5

-- Соседи тайла по восьми направлениям.
local AROUND = { { -1, -1 }, { 0, -1 }, { 1, -1 }, { -1, 0 }, { 1, 0 }, { -1, 1 }, { 0, 1 }, { 1, 1 } }

local function inside(w, x: number, y: number): boolean
	local size = w.game.data and w.game.data.size
	return size ~= nil and x >= -size and y >= -size and x < size and y < size
end

-- Ярус тайла; у гор — -1: их байт рельефа занят вершиной.
local function tierAt(w, x: number, y: number): number
	local terrain, _, _, relief = w:tile(x, y)
	if terrain == nil or terrain == MOUNTAIN then
		return -1
	end
	return bit32.band(relief, 3)
end

-- Вершина горы, частью которой стоит тайл: { x, y, radius }; не гора — nil.
function earthworks.peakOf(w, x: number, y: number)
	local px, py, radius = w:peak(x, y)
	return if px then { x = px, y = py, radius = radius } else nil
end

-- Тайлы горы с вершиной peak: x и y подряд (peakTiles).
function earthworks.peakTiles(w, peak): { number }
	local tiles = {}
	local span = math.ceil(peak.radius + 1)
	for y = math.floor(peak.y) - span, math.floor(peak.y) + span do
		for x = math.floor(peak.x) - span, math.floor(peak.x) + span do
			if inside(w, x, y) then
				local other = earthworks.peakOf(w, x, y)
				if other and other.x == peak.x and other.y == peak.y then
					table.insert(tiles, x)
					table.insert(tiles, y)
				end
			end
		end
	end
	return tiles
end

-- Кромка ли обрыва тайл: обрывистая, а рядом есть тайл ниже — подножие под ней (isCliffEdge).
function earthworks.isCliffEdge(w, x: number, y: number): boolean
	if not inside(w, x, y) then
		return false
	end
	local terrain, _, _, relief = w:tile(x, y)
	if terrain == nil or terrain == MOUNTAIN or bit32.band(relief, CLIFF_BIT) == 0 then
		return false
	end
	local tier = bit32.band(relief, 3)
	for _, d in AROUND do
		local other = tierAt(w, x + d[1], y + d[2])
		if other >= 0 and other < tier then
			return true
		end
	end
	return false
end

-- Тайлы кромки, которые сгладит рамка tiles (x и y подряд): кромки в рамке и кромки над подножиями в ней — стенку
-- обрыва рисуют на подножии, и рамку игрок тянет по ней (cliffEdgesIn). x и y подряд, без повторов.
function earthworks.cliffEdgesIn(w, tiles: { number }): { number }
	local found, seen = {}, {}
	local function add(x: number, y: number)
		local key = x .. ":" .. y
		if not seen[key] then
			seen[key] = true
			table.insert(found, x)
			table.insert(found, y)
		end
	end
	for i = 1, #tiles - 1, 2 do
		local x, y = tiles[i], tiles[i + 1]
		if earthworks.isCliffEdge(w, x, y) then
			add(x, y)
		end
		local tier = tierAt(w, x, y)
		for _, d in AROUND do
			if tierAt(w, x + d[1], y + d[2]) > tier and earthworks.isCliffEdge(w, x + d[1], y + d[2]) then
				add(x + d[1], y + d[2])
			end
		end
	end
	return found
end

-- Работа, которая уже идёт на тайле: кромку сглаживают или гору, частью которой он стоит, срывают (digAt).
function earthworks.digAt(w, x: number, y: number): number?
	local peak = earthworks.peakOf(w, x, y)
	for _, e in w:each({ "Dig", "Position" }) do
		local dig, at = w:get(e, "Dig"), w:get(e, "Position")
		if (dig.kind == "cliff" and at.x == x and at.y == y) or (dig.kind == "peak" and peak and dig.peakX == peak.x and dig.peakY == peak.y) then
			return e
		end
	end
	return nil
end

-- Можно ли игроку начать работу kind на тайле: исследовано, не в чужой зоне, есть что делать и это ещё не делают
-- (canDig).
function earthworks.canDig(w, player: number, kind: string, x: number, y: number, all: any?): boolean
	if x ~= math.floor(x) or y ~= math.floor(y) or not table.find(earthworks.KINDS, kind) or not inside(w, x, y) then
		return false
	end
	if not construction.researched(w, player, earthworks.RESEARCH) then
		return false
	end
	if (kind == "peak" and not earthworks.peakOf(w, x, y)) or (kind == "cliff" and not earthworks.isCliffEdge(w, x, y)) then
		return false
	end
	if earthworks.digAt(w, x, y) then
		return false
	end
	return not zones.inForeign(w, player, x, y, 1, 1, all)
end

-- Работы, которые закажет рамка tiles: на каждую гору — одна, на тайл кромки — своя; место, вершина и цена (digsIn).
function earthworks.digsIn(w, player: number, kind: string, tiles: { number })
	local jobs = {}
	local all = zones.all(w)
	if kind == "cliff" then
		local edges = earthworks.cliffEdgesIn(w, tiles)
		for i = 1, #edges - 1, 2 do
			local x, y = edges[i], edges[i + 1]
			if earthworks.canDig(w, player, kind, x, y, all) then
				table.insert(jobs, { x = x, y = y, peakX = 0, peakY = 0, cost = earthworks.CLIFF_COST })
			end
		end
		return jobs
	end
	local seen = {}
	for i = 1, #tiles - 1, 2 do
		local peak = earthworks.peakOf(w, tiles[i], tiles[i + 1])
		local key = peak and (peak.x .. ":" .. peak.y)
		if peak and not seen[key] and earthworks.canDig(w, player, kind, tiles[i], tiles[i + 1], all) then
			seen[key] = true
			table.insert(jobs, { x = math.floor(peak.x), y = math.floor(peak.y), peakX = peak.x, peakY = peak.y, cost = #earthworks.peakTiles(w, peak) / 2 * earthworks.PEAK_COST })
		end
	end
	return jobs
end

-- Над какими тайлами идёт работа: прямоугольник для строителей; nil — делать уже нечего (гору сорвали) (digArea).
function earthworks.area(w, e: number)
	local dig, at = w:get(e, "Dig"), w:get(e, "Position")
	if not dig or not at then
		return nil
	end
	if dig.kind == "cliff" then
		return if earthworks.isCliffEdge(w, at.x, at.y) then { x = at.x, y = at.y, width = 1, height = 1 } else nil
	end
	local peak = earthworks.peakOf(w, at.x, at.y)
	if not peak or peak.x ~= dig.peakX or peak.y ~= dig.peakY then
		return nil
	end
	local tiles = earthworks.peakTiles(w, peak)
	local left, top, right, bottom = math.huge, math.huge, -math.huge, -math.huge
	for i = 1, #tiles - 1, 2 do
		left, top = math.min(left, tiles[i]), math.min(top, tiles[i + 1])
		right, bottom = math.max(right, tiles[i] + 1), math.max(bottom, tiles[i + 1] + 1)
	end
	return { x = left, y = top, width = right - left, height = bottom - top }
end

-- Самый частый ярус соседей горы: скала на её месте ложится вровень с плато вокруг (tierAround).
local function tierAround(w, tiles: { number }): number
	local counts = { [0] = 0, 0, 0, 0 }
	local own = {}
	for i = 1, #tiles - 1, 2 do
		own[tiles[i] .. ":" .. tiles[i + 1]] = true
	end
	for i = 1, #tiles - 1, 2 do
		for _, d in AROUND do
			local x, y = tiles[i] + d[1], tiles[i + 1] + d[2]
			if not own[x .. ":" .. y] and inside(w, x, y) then
				local tier = tierAt(w, x, y)
				if tier >= 0 then
					counts[tier] += 1
				end
			end
		end
	end
	local best = 1
	for tier = 0, 3 do
		if counts[tier] > counts[best] then
			best = tier
		end
	end
	return best
end

-- Работа сделана (finishDig): гора становится скалой, кромка — пологой. Сущность работы исчезает. Только хост.
function earthworks.finish(ctx, e: number)
	local dig, at = ctx:get(e, "Dig"), ctx:get(e, "Position")
	if dig and at and earthworks.area(ctx, e) then
		local edits = {}
		if dig.kind == "cliff" then
			local terrain, biome, _, relief = ctx:tile(at.x, at.y)
			-- Пологая кромка: ярус и барханы те же, без CLIFF_BIT.
			local dunes = bit32.band(relief, bit32.lshift(3, DUNE_SHIFT))
			table.insert(edits, { at.x, at.y, terrain, biome, 0, bit32.bor(bit32.band(relief, 3), dunes) })
		else
			local tiles = earthworks.peakTiles(ctx, earthworks.peakOf(ctx, at.x, at.y))
			local tier = tierAround(ctx, tiles)
			for i = 1, #tiles - 1, 2 do
				local _, biome = ctx:tile(tiles[i], tiles[i + 1])
				table.insert(edits, { tiles[i], tiles[i + 1], ROCK, biome, 0, tier })
			end
		end
		local flat = {}
		for _, edit in edits do
			table.move(edit, 1, 6, #flat + 1, flat)
		end
		ctx:edit_tiles(flat)
	end
	ctx:destroy(e)
end

return earthworks
