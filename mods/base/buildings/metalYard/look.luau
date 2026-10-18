--!strict
-- Склад металла, 3×2: открытый двор со штабелями слитков и козловым краном над ними.

local b = require("lib/buildings")

local IRON, INK, HAZARD = b.IRON, b.INK, b.HAZARD
local TURN, round, pulse = b.TURN, b.round, b.pulse

return b.look(3, 2, function(g, t: number)
	local tint = b.accent(b.goodColor("metal"))
	b.slab(g, 0, 1, 48, 31, 3, IRON)
	g:rect(2, 3, 44, 24, IRON[1])
	for x = 3, 45, 8 do
		g:rect(x, 26, 4, 1, HAZARD[1])
	end
	-- Штабеля: каждый — три ряда слитков.
	for _, sx in { 4, 19, 34 } do
		for row = 0, 2 do
			for k = 0, 1 do
				local x, y = sx + k * 5, 6 + row * 6
				g:rect(x, y, 5, 5, INK)
				g:rect(x + 1, y + 1, 3, 3, tint[1])
				g:rect(x + 1, y + 1, 3, 1, tint[2])
			end
		end
	end
	-- Козловой кран ходит над штабелями.
	local x = round(6 + 34 * (0.5 - 0.5 * math.cos(TURN * t)))
	g:rect(x, 2, 3, 25, INK)
	g:rect(x + 1, 2, 1, 25, HAZARD[1])
	g:rect(x - 1, 12, 5, 3, IRON[3])
	b.bulb(g, 2, 28, pulse(t))
	b.bulb(g, 44, 28, pulse(t, 0.5))
end)
