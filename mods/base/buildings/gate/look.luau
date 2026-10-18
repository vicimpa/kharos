--!strict
-- Ворота, 1×1: плита, выезжающая из земли. Поднятая — та же секция стены с предупредительными полосами: рукава тянутся
-- к соседним секциям ворот и к стене. Опущенная — люк вровень с землёй: рама, щель и зелёные огни по углам; соседние
-- люки сливаются в одну полосу. Вариант — биты соседей и бит GATE_OPEN.

local b = require("lib/buildings")

local STEEL, IRON, INK, HAZARD, FIRE = b.STEEL, b.IRON, b.INK, b.HAZARD, b.FIRE
local band = bit32.band

return b.look(1, 1, function(g, t: number, _working: boolean, variant: number)
	local north = band(variant, b.NORTH) ~= 0
	local east = band(variant, b.EAST) ~= 0
	local south = band(variant, b.SOUTH) ~= 0
	local west = band(variant, b.WEST) ~= 0
	-- Одиночная секция и секция в ряду слева направо лежат поперёк; в ряду сверху вниз — вдоль.
	local upright = (north or south) and not east and not west
	local left = if west then 0 else 2
	local right = if east then 16 else 14
	local top = if north then 0 else 2
	local bottom = if south then 16 else 14
	if band(variant, b.GATE_OPEN) ~= 0 then
		-- Люк: рама до края тайла со стороны соседа, внутри — тёмная крышка со щелью, куда ушла плита.
		local x, y, width, height
		if upright then
			x, y, width, height = 3, top, 10, bottom - top
		else
			x, y, width, height = left, 3, right - left, 10
		end
		g:rect(x, y, width, height, INK)
		local insetX = if upright then 1 elseif west then 0 else 1
		local insetY = if upright then (if north then 0 else 1) else 1
		local innerWidth = width - (if upright then 2 else (if west then 0 else 1) + (if east then 0 else 1))
		local innerHeight = height - (if upright then (if north then 0 else 1) + (if south then 0 else 1) else 2)
		g:rect(x + insetX, y + insetY, innerWidth, innerHeight, STEEL[0])
		if upright then
			g:rect(7, top, 2, bottom - top, INK)
			local mark = top + 2
			while mark + 1 < bottom do
				g:rect(4, mark, 2, 1, HAZARD[1])
				g:rect(10, mark, 2, 1, HAZARD[1])
				mark += 4
			end
		else
			g:rect(left, 7, right - left, 2, INK)
			local mark = left + 2
			while mark + 1 < right do
				g:rect(mark, 4, 1, 2, HAZARD[1])
				g:rect(mark, 10, 1, 2, HAZARD[1])
				mark += 4
			end
		end
		g:rect(7, 7, 2, 2, 0x5fe08a)
		g:light(8, 8, 1.5, 0.3)
		return
	end
	-- Поднятая плита: как секция стены, но сплошная и в полосах.
	if upright then
		g:rect(4, top, 9, bottom - top, INK)
		g:rect(5, top, 6, bottom - top, IRON[1])
		g:rect(5, top, 1, bottom - top, IRON[3])
		g:rect(11, top, 1, bottom - top, IRON[0])
		local mark = top + 1
		while mark + 2 < bottom do
			g:rect(6, mark, 4, 2, HAZARD[1])
			mark += 4
		end
	else
		g:rect(left, 4, right - left, 9, INK)
		g:rect(left, 5, right - left, 6, IRON[1])
		g:rect(left, 5, right - left, 1, IRON[3])
		g:rect(left, 11, right - left, 1, IRON[0])
		local mark = left + 1
		while mark + 2 < right do
			g:rect(mark, 7, 2, 3, HAZARD[1])
			mark += 4
		end
	end
	g:rect(7, 7, 2, 2, FIRE[2])
	g:light(8, 8, 1.5, 0.45 + 0.3 * b.pulse(t))
end, { variants = 32 })
