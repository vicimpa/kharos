--!strict
-- Радар, 2×2 — перенос radar из buildingArt.ts: мачта с вращающейся тарелкой и аппаратная будка.

local b = require("lib/buildings")

local STEEL, IRON, TEAM, INK = b.STEEL, b.IRON, b.TEAM, b.INK
local TURN, round, pulse, chase = b.TURN, b.round, b.pulse, b.chase

return b.look(2, 2, function(g, t: number)
	b.slab(g, 0, 2, 32, 30, 3, STEEL)
	g:rect(3, 5, 26, 21, STEEL[0])
	g:rect(4, 6, 25, 20, STEEL[1])
	b.bulb(g, 4, 6, chase(t, 0))
	b.bulb(g, 26, 23, chase(t, 0.5))

	b.slab(g, 3, 15, 11, 12, 4, IRON)
	b.windows(g, { 5, 9 }, 22)
	b.lamp(g, 8, 18, 1, pulse(t * 2))

	b.tower(g, 20, 17, 6, 7, IRON)
	-- Тарелка видна под наклоном: по вертикали всё сжато.
	local angle = t * TURN
	local dx, dy = math.cos(angle), math.sin(angle) * 0.65
	local px, py = -math.sin(angle) * 9, math.cos(angle) * 9 * 0.65
	local cx, cy = 20, 8
	g:line(cx - px, cy - py, cx + px, cy + py, 5, INK)
	g:line(cx - px, cy - py, cx + px, cy + py, 3, IRON[3])
	g:line(cx - px + dx, cy - py + dy, cx + px + dx, cy + py + dy, 1.2, IRON[4])
	g:line(cx, cy, cx + dx * 5, cy + dy * 5, 1.2, IRON[1])
	g:rect(round(cx + dx * 5) - 1, round(cy + dy * 5) - 1, 2, 2, TEAM[3])
end)
