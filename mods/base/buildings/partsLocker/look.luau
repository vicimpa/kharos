--!strict
-- Шкаф компонентов, 1×1 — перенос partsLocker из buildingArt.ts: закрытая стойка с ящичками, на каждом — огонёк учёта.

local b = require("lib/buildings")

local STEEL, INK = b.STEEL, b.INK
local pulse, chase = b.pulse, b.chase

return b.look(1, 1, function(g, t: number)
	local tint = b.accent(b.GOOD_COLORS.parts)
	b.slab(g, 0, 1, 16, 15, 2, STEEL)
	g:rect(2, 3, 12, 9, INK)
	-- Ящички в два столбца, огоньки бегут сверху вниз.
	for row = 0, 2 do
		for _, x in { 3, 9 } do
			g:rect(x, 4 + row * 3, 4, 2, STEEL[2])
			g:rect(x + 1, 4 + row * 3, 2, 1, STEEL[3])
		end
		local level = chase(t, row / 3)
		g:rect(7, 4 + row * 3, 2, 2, if level > 0.3 then tint[2] else tint[0])
	end
	g:light(8, 7, 2, 0.3 + 0.3 * pulse(t))
end)
