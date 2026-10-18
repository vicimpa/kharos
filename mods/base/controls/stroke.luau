--!strict
-- Протяжка (scene.paving в controls.ts, paveStrokeOf в placing.ts, pavingPass.ts, cursorPass.ts): кнопка трубы,
-- колодцев, стены, ворот, покрытия или «Снять» включает режим c.shared.mode = { kind = "paving", tool }. Труба, стена,
-- ворота и дорога тянутся мышью линией с одним изломом — сначала вдоль длинной стороны, потом поперёк; фундамент и
-- «Снять» — прямоугольником, землеройные работы — рамкой по горе или обрыву (подсвечено, что сроют или сгладят); колодцы — щелчком по одному (свяжется с колодцем по прямой) или протяжкой парой до 10
-- тайлов. Под указателем — призраки по тайлам: годные — светлые, негодные — красные; у покрытия — рамки тайлов:
-- зелёные, жёлтые там, где не хватит кредитов (покрытие оплачивают сразу), оранжевые — что снимут. Сколько это стоит,
-- видно на полосе режима. Отпустили — закладывается то, что годится; режим остаётся. Правая кнопка и Esc — отмена; без
-- выбранных строителей режим кончается сам.

local construction = require("lib/construction")
local paving = require("lib/paving")
local earthworks = require("lib/earthworks")
local zones = require("lib/zones")
local conversion = require("lib/conversion")

local stroke = {}

-- Призраки, как у выбора места (GHOST, GHOST_FORBIDDEN), с предумноженной альфой.
local GHOST = { 0.7, 0.7, 0.7, 0.7 }
local FORBIDDEN_GHOST = { 0.7, 0.14, 0.1, 0.7 }
local UNDERGROUND_REACH = 10
-- Рамки тайлов покрытия (ALLOWED, REMOVE, SHORT, FORBIDDEN, FILL_ALPHA, BORDER_ALPHA в cursorPass.ts).
local ALLOWED, REMOVE, SHORT, FORBIDDEN = 0x59ff73, 0xffa633, 0xffd926, 0xff4d40
local FILL_ALPHA, BORDER_ALPHA = 0.18, 0.85
-- Инструменты покрытия: они не здания.
local SURFACE = { foundation = true, road = true, remove = true, peak = true, cliff = true }
-- Землеройные инструменты: рамка, а заказ хост соберёт из неё (digsIn).
local DIG = { peak = true, cliff = true }

-- Есть ли такой инструмент: здание протяжки или покрытие.
function stroke.known(c, tool: string): boolean
	return SURFACE[tool] == true or c.protos.buildings[tool] ~= nil
end

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

-- Протянутое покрытие или снятие (paveStrokeOf): фундамент и снятие — прямоугольником, дорога — линией; покрытие
-- оплачивают сразу — кредиты считаются по тайлу в том же порядке, на что не хватит, то и не ляжет. Третье — каким
-- тайлам не хватило кредитов.
local function surfaceOf(c, tool: string, start, tile): ({ number }, { boolean }, number, { boolean }, { number }?)
	local tiles = {}
	if tool == "road" then
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
	else
		for y = math.min(start.y, tile.y), math.max(start.y, tile.y) do
			for x = math.min(start.x, tile.x), math.max(start.x, tile.x) do
				table.insert(tiles, x)
				table.insert(tiles, y)
			end
		end
	end
	while #tiles > paving.LIMIT * 2 do
		table.remove(tiles)
	end
	local allowed, short = {}, {}
	local cost = 0
	if DIG[tool] then
		-- Землеройные работы в рамке (digStrokeOf): подсвечены тайлы каждой работы; на что не хватит кредитов — жёлтым.
		local credits = construction.credits(c, c.player)
		local shown = {}
		for _, job in earthworks.digsIn(c, c.player, tool, tiles) do
			local affordable = cost + job.cost <= credits
			if affordable then
				cost += job.cost
			end
			local peak = tool == "peak" and earthworks.peakOf(c, job.x, job.y)
			local covered = if peak then earthworks.peakTiles(c, peak) else { job.x, job.y }
			for i = 1, #covered - 1, 2 do
				table.insert(shown, covered[i])
				table.insert(shown, covered[i + 1])
				table.insert(allowed, affordable)
				table.insert(short, not affordable)
			end
		end
		return shown, allowed, cost, short, tiles
	end
	if tool == "remove" then
		local covered = {}
		for i = 1, #tiles - 1, 2 do
			covered[tiles[i] .. ":" .. tiles[i + 1]] = true
		end
		local core = conversion.building(c)
		for i = 1, #tiles - 1, 2 do
			table.insert(allowed, paving.removable(c, c.player, tiles[i], tiles[i + 1], covered, core))
			table.insert(short, false)
		end
		return tiles, allowed, 0, short
	end
	local credits = construction.credits(c, c.player)
	local all = zones.all(c)
	local taken = {}
	for i = 1, #tiles - 1, 2 do
		local x, y = tiles[i], tiles[i + 1]
		local key = x .. ":" .. y
		local price = if not taken[key] and paving.canPave(c, c.player, tool, x, y, all) then paving.cost(c, tool, x, y) else nil
		local affordable = price ~= nil and cost + price <= credits
		taken[key] = true
		table.insert(allowed, affordable)
		table.insert(short, price ~= nil and not affordable)
		if affordable then
			cost += price :: number
		end
	end
	return tiles, allowed, cost, short
end

-- Протянутое: тайлы x, y подряд, какие годятся и цена годных (paveStrokeOf); четвёртое — каким не хватило кредитов.
function stroke.of(c, tool: string): ({ number }, { boolean }, number, { boolean }?, { number }?)
	local tile = { x = math.floor(c.input.wx), y = math.floor(c.input.wy) }
	local start = from or tile
	if SURFACE[tool] then
		return surfaceOf(c, tool, start, tile)
	end
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
	if #units == 0 or not stroke.known(c, mode.tool) then
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
	local tiles, allowed, cost, short, frame = stroke.of(c, mode.tool)
	local lacking = 0
	for _, item in short or {} do
		if item then
			lacking += 1
		end
	end
	shared.paving = { tool = mode.tool, tiles = if from then #tiles // 2 else 0, cost = cost, short = if from then lacking else 0 }
	if input.inside then
		local good = if mode.tool == "remove" then REMOVE else ALLOWED
		for i, ok in allowed do
			local x, y = tiles[i * 2 - 1], tiles[i * 2]
			if short then
				local color = if ok then good elseif short[i] then SHORT else FORBIDDEN
				c.draw:rect(x, y, x + 1, y + 1, color, nil, FILL_ALPHA)
				c.draw:rect(x, y, x + 1, y + 1, color, 1, BORDER_ALPHA)
			else
				c:show(kind, x + 0.5, y + 0.5, { tint = if ok then GHOST else FORBIDDEN_GHOST, over = true })
			end
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
		if DIG[mode.tool] then
			c:send("dig", { kind = mode.tool, tiles = frame, builders = units, queue = c.input.keys.shift })
		elseif mode.tool == "foundation" or mode.tool == "road" then
			c:send("pave", { kind = mode.tool, tiles = tiles, builders = units, queue = c.input.keys.shift })
		elseif mode.tool == "remove" then
			c:send("remove", { tiles = tiles, builders = units, queue = c.input.keys.shift })
		elseif mode.tool == "pipe" then
			c:send("pipes", { tiles = tiles, builders = units, queue = c.input.keys.shift })
		elseif mode.tool == "well" then
			c:send("wells", { tiles = tiles, builders = units, queue = c.input.keys.shift })
		else
			c:send("walls", { tiles = tiles, builders = units, gate = mode.tool == "gate", queue = c.input.keys.shift })
		end
	end
end

return stroke
