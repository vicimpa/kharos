--!strict
-- Ветроуловитель, 2×2 — перенос windtrap из buildingArt.ts: широкая шахта с крыльчаткой.

local b = require("lib/buildings")

local STEEL, IRON, RUST, INK, DARK = b.STEEL, b.IRON, b.RUST, b.INK, b.DARK
local TURN, pulse = b.TURN, b.pulse

return b.look(2, 2, function(g, t: number)
	b.slab(g, 0, 2, 32, 30, 3, STEEL)
	for _, x in { 3, 25 } do
		g:rect(x, 5, 4, 1, RUST[1])
		g:rect(x, 26, 4, 1, RUST[1])
	end

	b.tower(g, 16, 17, 11, 4, STEEL)
	g:circle(16, 13, 8, INK)
	g:circle(16, 13, 7, DARK)
	-- Четыре лопасти: четверть оборота замыкает цикл.
	local angle = t * TURN * 0.25
	for _, turn in { angle, angle + TURN / 4 } do
		local dx, dy = math.cos(turn) * 7, math.sin(turn) * 7
		g:line(16 - dx, 13 - dy, 16 + dx, 13 + dy, 2, IRON[2])
	end
	b.lamp(g, 16, 13, 2, pulse(t * 2))
end)
