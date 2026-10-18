--!strict
-- Генератор щита, 2×2 — перенос shieldGenerator из buildingArt.ts: эмиттер на массивном основании — шар в кольце из
-- четырёх рёбер-излучателей; по рёбрам вверх бегут огни, шар дышит светом цвета команды.

local b = require("lib/buildings")

local STEEL, IRON, TEAM, INK = b.STEEL, b.IRON, b.TEAM, b.INK
local round, pulse, chase, teamColor = b.round, b.pulse, b.chase, b.teamColor

return b.look(2, 2, function(g, t: number)
	b.slab(g, 0, 2, 32, 30, 3, STEEL)
	-- Основание: восьмигранная плита с кольцевой канавкой.
	g:circle(16, 17, 12, INK)
	g:circle(16, 17, 11, IRON[1])
	g:circle(16, 17, 9, IRON[0])
	g:circle(16, 17, 8, IRON[2])
	-- Четыре ребра-излучателя по углам; огни бегут к шару.
	for index, corner in { { 6, 7 }, { 26, 7 }, { 6, 27 }, { 26, 27 } } do
		local i, cx, cy = index - 1, corner[1], corner[2]
		g:line(cx, cy, 16, 15, 3, INK)
		g:line(cx, cy, 16, 15, 1, STEEL[3])
		b.tower(g, cx, cy, 2, 3, STEEL)
		local k = chase(t * 2, i / 4)
		local along = (t * 2 + i / 4) % 1
		g:rect(round(cx + (16 - cx) * along) - 1, round(cy - 3 + (15 - cy + 3) * along) - 1, 2, 2, teamColor(0.4 + 0.6 * k))
	end
	-- Шар: стекло с бликом и свет, который дышит.
	local glow = 0.55 + 0.45 * pulse(t * 2)
	g:circle(16, 13, 7, INK)
	g:circle(16, 13, 6, TEAM[0])
	g:circle(16, 13, 5, teamColor(0.3 + 0.4 * glow))
	g:circle(15, 12, 3, teamColor(0.5 + 0.5 * glow))
	g:rect(13, 10, 2, 1, TEAM[3])
	g:light(16, 13, 6, glow)
end)
