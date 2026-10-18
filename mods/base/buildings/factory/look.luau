--!strict
-- Машинный завод, 3×3: сборочный цех под ребристой крышей с мостовым краном, ворота на юг и двор с пандусом, где стоит
-- выкаченная машина. Вентилятор на крыше крутится, огни над воротами бегут.

local b = require("lib/buildings")

local INK, STEEL, IRON, TEAM, HAZARD, DARK = b.INK, b.STEEL, b.IRON, b.TEAM, b.HAZARD, b.DARK
local TURN = math.pi * 2

local look = b.look(3, 3, function(g, t: number)
	b.slab(g, 0, 2, 48, 46, 3, STEEL)

	-- Двор: бетон с разметкой и пандус от ворот.
	g:rect(3, 30, 42, 14, IRON[1])
	g:rect(3, 30, 42, 1, IRON[0])
	for x = 5, 43, 6 do
		g:rect(x, 42, 3, 1, HAZARD[1])
	end
	g:rect(16, 30, 16, 12, IRON[0])
	for y = 32, 41, 3 do
		g:rect(17, y, 14, 1, IRON[2])
	end
	-- Выкаченная машина на пандусе: корпус, гусеницы, башня.
	g:rect(19, 33, 10, 8, INK)
	g:rect(19, 33, 2, 8, IRON[0])
	g:rect(27, 33, 2, 8, IRON[0])
	g:rect(21, 34, 6, 6, TEAM[1])
	g:rect(21, 34, 6, 1, TEAM[2])
	g:circle(24, 37, 2, STEEL[3])
	g:rect(24, 31, 1, 4, INK)

	-- Цех: длинный корпус с рёбрами крыши, по которой ездит кран.
	b.slab(g, 2, 0, 44, 30, 4, IRON)
	for x = 5, 41, 4 do
		g:rect(x, 2, 1, 22, IRON[0])
		g:rect(x + 1, 2, 1, 22, IRON[2])
	end
	-- Мостовой кран: балка поперёк цеха ходит вдоль него туда и обратно.
	local crane = math.round(8 + 28 * (0.5 - 0.5 * math.cos(TURN * t)))
	g:rect(crane - 1, 2, 4, 22, INK)
	g:rect(crane, 2, 2, 22, HAZARD[1])
	g:rect(crane - 1, 11, 4, 4, IRON[3])
	-- Ворота в торце цеха.
	g:rect(16, 23, 16, 7, INK)
	g:rect(17, 24, 14, 6, DARK)
	for i = 0, 6 do
		g:rect(17 + i * 2, 22, 2, 1, b.teamColor(b.chase(t, i / 7)))
	end

	-- Вентилятор на крыше: у крыльчатки четыре лопасти, четверть оборота замыкает цикл.
	g:circle(39, 8, 5, INK)
	g:circle(39, 8, 4, IRON[0])
	local angle = t * TURN * 0.25
	for _, turn in { angle, angle + TURN / 4 } do
		local dx, dy = math.cos(turn) * 3.5, math.sin(turn) * 3.5
		g:line(39 - dx, 8 - dy, 39 + dx, 8 + dy, 1.2, IRON[3])
	end
	b.lamp(g, 7, 36, 2, b.pulse(t))
	b.lamp(g, 41, 36, 2, b.pulse(t, 0.5))
end)

return look
