--!strict
-- Покрытие (pavingPass.ts): фундамент, дороги и мосты — тайлы на экране, а не обход мира. Дорога по болоту рисуется
-- мостом; соседние тайлы одного вида сливаются (sprites/paving). Что кладут или разбирают — бледнее, заменяемое
-- рисуется новым. Чужое покрытие видно там, где игрок бывал (памяти о покрытии в тумане пока нет — Б6).

local surface = require("lib/surface")
local paveArt = require("lib/paveArt")

-- Недостроенное и разбираемое покрытие просвечивает: видно, что над ним работают (UNFINISHED_ALPHA).
local UNFINISHED = 0.45
local SWAMP = 0
local FOUNDATION = 1
local CODES = { foundation = 1, road = 2 }
local UP, RIGHT, DOWN, LEFT = paveArt.UP, paveArt.RIGHT, paveArt.DOWN, paveArt.LEFT

local function update(c)
	local kind = c.protos.sprites.paving
	if not kind or not surface.enabled(c) then
		return
	end
	local zoom = c.camera.zoom
	local halfWidth, halfHeight = c.screen.w / 2 / zoom, c.screen.h / 2 / zoom
	local left, right = math.floor(c.camera.x - halfWidth), math.ceil(c.camera.x + halfWidth)
	local top, bottom = math.floor(c.camera.y - halfHeight), math.ceil(c.camera.y + halfHeight)
	-- Виды по тайлам окна и кольца вокруг него — по нему видно соседей крайних тайлов.
	local width = right - left + 3
	local function keyOf(x: number, y: number): number
		return (x - left + 1) + (y - top + 1) * width
	end
	local codes: { [number]: number } = {}
	local working: { [number]: boolean } = {}
	local flat = c:layer_in("paving", left - 1, top - 1, width, bottom - top + 3)
	for i = 1, #flat, 3 do
		local x, y = flat[i], flat[i + 1]
		if c:layer("paving", x, y, 1) == c.player or c:explored(x + 0.5, y + 0.5) then
			codes[keyOf(x, y)] = flat[i + 2]
		end
	end
	for _, e in c:each({ "Pave", "Position" }) do
		local x, y = surface.tileOf(c, e)
		if x >= left - 1 and x <= right + 1 and y >= top - 1 and y <= bottom + 1 and (c:mine(e) or c:explored(x + 0.5, y + 0.5)) then
			local key = keyOf(x, y)
			codes[key] = CODES[c:get(e, "Pave").kind]
			working[key] = true
		end
	end
	for key, code in codes do
		local x, y = key % width + left - 1, key // width + top - 1
		if x < left or x > right or y < top or y > bottom then
			continue
		end
		local mask = 0
		if codes[key - width] == code then
			mask += UP
		end
		if codes[key + 1] == code then
			mask += RIGHT
		end
		if codes[key + width] == code then
			mask += DOWN
		end
		if codes[key - 1] == code then
			mask += LEFT
		end
		-- Облики по порядку фаз: фундамент, дорога, мост.
		local look = if code == FOUNDATION then 0 elseif c:terrain(x, y) == SWAMP then 2 else 1
		local alpha = if working[key] then UNFINISHED else 1
		c:show(kind, x + 0.5, y + 0.5, { phase = look * 16 + mask, tint = { alpha, alpha, alpha, alpha } })
	end
end

return { update = update }
