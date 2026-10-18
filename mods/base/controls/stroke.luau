--!strict
-- Протяжка (scene.paving в controls.ts, paveStrokeOf в placing.ts, pavingPass.ts): кнопка трубы, колодцев, стены или
-- ворот включает режим c.shared.mode = { kind = "paving", tool }. Труба, стена и ворота тянутся мышью линией с одним
-- изломом — сначала вдоль длинной стороны, потом поперёк; колодцы — щелчком по одному (свяжется с колодцем по прямой)
-- или протяжкой парой до 10 тайлов. Под указателем — призраки по тайлам: годные — светлые, негодные — красные, а сколько
-- это стоит, видно на полосе режима. Отпустили — закладывается то, что годится; режим остаётся. Правая кнопка и Esc —
-- отмена; без выбранных строителей режим кончается сам.

local construction = require("lib/construction")

local stroke = {}

-- Призраки, как у выбора места (GHOST, GHOST_FORBIDDEN), с предумноженной альфой.
local GHOST = { 0.7, 0.7, 0.7, 0.7 }
local FORBIDDEN_GHOST = { 0.7, 0.14, 0.1, 0.7 }
local UNDERGROUND_REACH = 10

-- Откуда тянут: тайл, где зажали кнопку; nil — не зажали.
local from: { x: number, y: number }? = nil

-- Выбранные свои строители.
local function builders(c): { number }
	local list = {}
	for _, e in c.shared.selection or {} do
		if c:alive(e) and c:mine(e) and c:has(e, "Unit") and c:has(e, "Repair") then
			table.insert(list, e)
		end
	end
	return list
end

-- Протянутое: тайлы x, y подряд, какие годятся и цена годных (paveStrokeOf).
function stroke.of(c, tool: string): ({ number }, { boolean }, number)
	local tile = { x = math.floor(c.input.wx), y = math.floor(c.input.wy) }
	local start = from or tile
	local kind = c.protos.buildings[tool]
	local tiles = {}
	if tool == "well" then
		local horizontal = math.abs(tile.x - start.x) >= math.abs(tile.y - start.y)
		local along = if horizontal then tile.x - start.x else tile.y - start.y
		local length = math.min(math.abs(along), UNDERGROUND_REACH) * math.sign(along)
		tiles = { start.x, start.y }
		if length ~= 0 then
			table.insert(tiles, if horizontal then start.x + length else start.x)
			table.insert(tiles, if horizontal then start.y else start.y + length)
		end
		-- Конец, где свой колодец уже стоит, не закладывают: от него тянут второй.
		local kept = construction.wellsKept(c, c.player, tiles)
		local fits = construction.pipeStroke(c, c.player, tiles, kind)
		local fresh = 0
		for _, item in kept do
			if not item then
				fresh += 1
			end
		end
		local valid = (#tiles == 2 or construction.isWellPair(tiles)) and fresh > 0
		local allowed = {}
		for i, ok in fits do
			allowed[i] = (ok or kept[i]) and valid
		end
		return tiles, allowed, if valid then kind.data.cost * fresh else 0
	end
	local horizontal = math.abs(tile.x - start.x) >= math.abs(tile.y - start.y)
	local corner = if horizontal then { x = tile.x, y = start.y } else { x = start.x, y = tile.y }
	local function walk(a, b, skipFirst: boolean)
		local stepX, stepY = math.sign(b.x - a.x), math.sign(b.y - a.y)
		local length = math.max(math.abs(b.x - a.x), math.abs(b.y - a.y))
		for i = if skipFirst then 1 else 0, length do
			table.insert(tiles, a.x + stepX * i)
			table.insert(tiles, a.y + stepY * i)
		end
	end
	walk(start, corner, false)
	walk(corner, tile, true)
	while #tiles > construction.STROKE_LIMIT * 2 do
		table.remove(tiles)
	end
	local allowed = if tool == "pipe" then construction.pipeStroke(c, c.player, tiles, kind) else construction.wallStroke(c, c.player, tiles, kind)
	local cost = 0
	for _, ok in allowed do
		if ok then
			cost += kind.data.cost
		end
	end
	return tiles, allowed, cost
end

function stroke.update(c)
	local shared, input = c.shared, c.input
	local mode = shared.mode
	if not mode or mode.kind ~= "paving" or shared.paused then
		from = nil
		return
	end
	local units = builders(c)
	local kind = c.protos.buildings[mode.tool]
	if #units == 0 or not kind then
		shared.mode = nil
		from = nil
		return
	end
	if input.hits.escape then
		shared.mode = nil
		shared.modeClosedAt = c.time
		from = nil
		return
	end
	if input.pressed.right and input.inside and not input.over_ui then
		-- Тот же щелчок приказом уже не станет (controls/orders).
		shared.mode = nil
		shared.modeClosedAt = c.time
		from = nil
		return
	end
	if input.pressed.left and input.inside and not input.over_ui then
		from = { x = math.floor(input.wx), y = math.floor(input.wy) }
	end
	local tiles, allowed, cost = stroke.of(c, mode.tool)
	shared.paving = { tool = mode.tool, tiles = if from then #tiles // 2 else 0, cost = cost }
	if input.inside then
		for i, ok in allowed do
			c:show(kind, tiles[i * 2 - 1] + 0.5, tiles[i * 2] + 0.5, { tint = if ok then GHOST else FORBIDDEN_GHOST, over = true })
		end
	end
	if from and input.released.left then
		from = nil
		local any = false
		for _, ok in allowed do
			any = any or ok
		end
		if not any then
			c:sound("deny", { volume = 0.35 })
			return
		end
		if mode.tool == "pipe" then
			c:send("pipes", { tiles = tiles, builders = units })
		elseif mode.tool == "well" then
			c:send("wells", { tiles = tiles, builders = units })
		else
			c:send("walls", { tiles = tiles, builders = units, gate = mode.tool == "gate" })
		end
	end
end

return stroke
