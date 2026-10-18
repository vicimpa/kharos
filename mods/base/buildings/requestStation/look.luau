--!strict
-- Станция запроса, 2×2 — перенос requestStation из buildingArt.ts: приёмная площадка с разметкой, на ней ящики разного
-- груза, рядом мачта с антенной — по ней станция зовёт грузовики; огонёк заявки мигает, а табло бегущими огнями
-- показывает приём.

local b = require("lib/buildings")

local STEEL, IRON, INK, HAZARD, GOOD = b.STEEL, b.IRON, b.INK, b.HAZARD, b.GOOD_COLORS
local pulse, chase = b.pulse, b.chase

return b.look(2, 2, function(g, t: number)
	b.slab(g, 0, 1, 32, 31, 2, IRON)
	-- Приёмная площадка: жёлто-чёрная рамка, внутри — бетон.
	g:rect(2, 10, 20, 18, INK)
	g:rect(3, 11, 18, 16, IRON[2])
	for i = 0, 17, 4 do
		g:rect(3 + i, 11, 2, 1, HAZARD[1])
		g:rect(3 + i, 26, 2, 1, HAZARD[1])
	end
	-- Ящики разного груза: металл, стройблоки, патроны, кремний.
	for _, crate in { { 5, 14, GOOD.metal }, { 12, 14, GOOD.blocks }, { 5, 20, GOOD.ammo }, { 12, 20, GOOD.silicon } } do
		local x, y = crate[1], crate[2]
		local tint = b.accent(crate[3])
		g:rect(x, y, 6, 5, INK)
		g:rect(x + 1, y + 1, 4, 3, tint[1])
		g:rect(x + 1, y + 1, 4, 1, tint[2])
	end
	-- Табло приёма над площадкой: огни бегут слева направо.
	g:rect(3, 4, 18, 5, INK)
	g:rect(4, 5, 16, 3, IRON[1])
	for i = 0, 3 do
		b.bulb(g, 5 + i * 4, 5, chase(t, i / 4))
	end
	-- Мачта с антенной справа: огонёк заявки на верхушке мигает.
	b.tower(g, 26, 26, 3, 16, STEEL)
	g:line(26, 8, 30, 3, 1, STEEL[2])
	g:line(26, 8, 22, 3, 1, STEEL[2])
	local level = pulse(t * 1.5)
	g:circle(26, 4, 1.6, INK)
	g:circle(26, 4, 1, if level > 0.5 then 0x5ff2d0 else 0x1d5a4c)
	g:light(26, 4, 2, level * 0.5)
end)
