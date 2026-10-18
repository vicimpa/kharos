--!strict
-- Перегонный завод, 2×3 — перенос distillery из buildingArt.ts: ректификационная колонна сверху, шаровые баки и
-- факел, где сгорает лишний газ.

local b = require("lib/buildings")

local STEEL, IRON, RUST, INK = b.STEEL, b.IRON, b.RUST, b.INK
local TURN, round, pulse, chase, fireColor = b.TURN, b.round, b.pulse, b.chase, b.fireColor

return b.look(2, 3, function(g, t: number, working: boolean)
	local tint = b.accent(b.GOOD_COLORS.fuel)
	b.slab(g, 0, 2, 32, 46, 3, STEEL)
	g:rect(3, 42, 26, 1, RUST[1])

	b.pipe(g, 4, 30, 24)
	b.pipe(g, 10, 22, 3)
	for _, x in { 8, 22 } do
		g:circle(x, 36, 6, INK)
		g:circle(x, 36, 5, tint[0])
		g:circle(x - 1, 35, 4, tint[1])
		g:rect(x - 3, 33, 2, 1, tint[2])
	end

	-- Колонна сверху: толстый круг с кольцевой площадкой; в работе по кольцу бегут огни.
	b.tower(g, 12, 16, 8, 3, STEEL)
	g:circle(12, 13, 5, INK)
	g:circle(12, 13, 4, STEEL[2])
	g:circle(11, 12, 2, STEEL[3])
	for i = 0, 5 do
		local angle = (TURN * i) / 6
		b.bulb(g, round(12 + math.cos(angle) * 6.5) - 1, round(13 + math.sin(angle) * 6.5) - 1, if working then chase(t, i / 6) else 0)
	end
	b.pipe(g, 19, 10, 5)

	-- Факел сверху: в работе пляшет огонь, в простое тлеет запальник.
	local flame = if working then pulse(t * 4) else 0
	g:circle(25, 10, 4, INK)
	g:circle(25, 10, 3, IRON[2])
	if working then
		g:circle(25, 10, 2 + flame, fireColor(0.55 + flame * 0.2))
		g:circle(25, 9, 1 + flame * 0.6, fireColor(0.95))
	else
		g:rect(25, 10, 1, 1, fireColor(0.5 + 0.3 * pulse(t)))
	end
	g:light(25, 9, 4, if working then 0.7 + flame * 0.3 else 0.1)
	b.lamp(g, 27, 24, 1, pulse(t))
end, { working = true })
