--!strict
-- Топливные баки, 2×2 — перенос fuelTank из buildingArt.ts: два круглых бака сверху, обвязка труб и задвижка.

local b = require("lib/buildings")

local STEEL, IRON, INK, HAZARD = b.STEEL, b.IRON, b.INK, b.HAZARD
local TURN, round, pulse = b.TURN, b.round, b.pulse

return b.look(2, 2, function(g, t: number)
	local tint = b.accent(b.GOOD_COLORS.fuel)
	b.slab(g, 0, 1, 32, 31, 3, STEEL)
	b.pipe(g, 3, 26, 26)
	for _, at in { { 10, 11 }, { 22, 19 } } do
		local x, y = at[1], at[2]
		g:circle(x, y, 8, INK)
		g:circle(x, y, 7, IRON[2])
		g:circle(x - 1, y - 1, 5, IRON[3])
		-- Плавающая крыша: кольцо цвета груза, по нему ходит блик.
		g:ring(x, y, 4, 1, tint[1])
		local angle = TURN * t
		g:rect(round(x + math.cos(angle) * 4), round(y + math.sin(angle) * 4), 1, 1, tint[2])
		g:circle(x, y, 1, INK)
	end
	-- Задвижка между баками.
	g:rect(14, 13, 4, 4, INK)
	g:rect(15, 14, 2, 2, HAZARD[1])
	b.bulb(g, 26, 4, pulse(t))
end)
