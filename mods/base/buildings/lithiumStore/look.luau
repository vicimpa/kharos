--!strict
-- Склад лития, 2×1 — перенос lithiumStore из buildingArt.ts: навес над стеллажом розовых брикетов, погрузочная
-- площадка и огонёк учёта.

local b = require("lib/buildings")

local IRON = b.IRON

return b.look(2, 1, function(g, t: number)
	local tint = b.accent(b.GOOD_COLORS.lithium)
	b.slab(g, 0, 1, 32, 15, 2, IRON)
	g:rect(2, 3, 28, 9, IRON[0])
	-- Стеллаж: три яруса брикетов.
	for x = 3, 21, 4 do
		for _, y in { 4, 7 } do
			g:rect(x, y, 3, 2, tint[1])
			g:rect(x, y, 3, 1, tint[2])
		end
	end
	-- Площадка и лампа учёта.
	g:rect(23, 4, 6, 7, IRON[2])
	g:rect(23, 4, 6, 1, IRON[3])
	b.bulb(g, 25, 6, 0.4 + 0.6 * b.pulse(t))
end)
