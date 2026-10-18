--!strict
-- Штаб, 3×3 — перенос command из buildingArt.ts: двухъярусная цитадель с куполом-маяком, угловыми башенками и мачтой
-- связи; на верхней платформе стоит турель главного здания (mounts).

local b = require("lib/buildings")

local STEEL, IRON, RUST, INK, DARK = b.STEEL, b.IRON, b.RUST, b.INK, b.DARK

return b.look(3, 3, function(g, t: number)
	b.slab(g, 0, 2, 48, 46, 3, STEEL)
	g:rect(18, 36, 12, 1, RUST[1])
	g:rect(18, 40, 12, 1, RUST[1])
	g:rect(18, 36, 1, 5, RUST[1])
	g:rect(29, 36, 1, 5, RUST[1])
	for _, corner in { { 5, 0.25 }, { 43, 0.75 } } do
		local x, offset = corner[1], corner[2]
		b.tower(g, x, 40, 3, 3, IRON)
		b.bulb(g, x - 1, 36, b.pulse(t, offset))
	end

	b.slab(g, 6, -2, 36, 36, 8, IRON)
	g:rect(20, 25, 8, 8, INK)
	g:rect(21, 26, 6, 7, DARK)
	b.windows(g, { 9, 14, 31, 36 }, 27)
	for i = 0, 3 do
		b.bulb(g, 20 + i * 2, 22, b.chase(t, i / 4))
	end

	b.slab(g, 12, -8, 24, 24, 5, STEEL)
	b.windows(g, { 14, 19, 26, 31 }, 11)
	-- Платформа пушки: на ней стоит турель главного здания.
	g:circle(24, 6, 9.5, INK)
	g:circle(24, 6, 8.5, IRON[1])
	g:circle(24, 6, 7, IRON[0])
	for _, bolt in { { 17, 6 }, { 31, 6 }, { 24, -1 }, { 24, 13 } } do
		g:rect(bolt[1] - 0.5, bolt[2] - 0.5, 1, 1, IRON[2])
	end
	b.lamp(g, 14, -5, 2, b.pulse(t))

	b.tower(g, 38, 20, 2, 7, IRON)
	b.bulb(g, 37, 12, b.chase(t * 2, 0))
end)
