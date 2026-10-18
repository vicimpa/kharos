--!strict
-- Аэродром, 4×3 — перенос airfield из buildingArt.ts: взлётная полоса с разметкой и бегущими огнями вдоль неё, ангар
-- с полукруглой крышей и открытыми воротами, где стоит самолёт, и диспетчерская вышка с вращающимся маяком.

local b = require("lib/buildings")

local STEEL, IRON, TEAM, INK, DARK = b.STEEL, b.IRON, b.TEAM, b.INK, b.DARK
local TURN, round, pulse, chase = b.TURN, b.round, b.pulse, b.chase

return b.look(4, 3, function(g, t: number)
	b.slab(g, 0, 2, 64, 46, 3, STEEL)

	-- Полоса вдоль нижнего края: асфальт, осевая разметка, огни по краям бегут к торцу.
	g:rect(3, 30, 58, 13, INK)
	g:rect(4, 31, 56, 11, 0x23262b)
	for x = 7, 57, 7 do
		g:rect(x, 36, 4, 1, 0xd8d2bf)
	end
	g:rect(5, 32, 1, 9, 0xd8d2bf)
	g:rect(58, 32, 1, 9, 0xd8d2bf)
	local LIGHTS = 8
	for i = 0, LIGHTS - 1 do
		local x = 7 + i * 7
		b.bulb(g, x, 30, chase(t, i / LIGHTS))
		b.bulb(g, x, 41, chase(t, i / LIGHTS))
	end

	-- Ангар: полукруглая крыша с рёбрами и открытые ворота.
	b.slab(g, 3, 1, 34, 28, 4, IRON)
	for x = 6, 34, 4 do
		g:rect(x, 3, 1, 18, IRON[0])
		g:rect(x + 1, 3, 1, 18, IRON[2])
	end
	g:rect(9, 18, 22, 10, INK)
	g:rect(10, 19, 20, 9, DARK)
	-- Самолёт в воротах носом наружу.
	g:rect(19, 20, 2, 8, STEEL[3])
	g:rect(13, 23, 14, 2, STEEL[2])
	g:rect(17, 20, 6, 1, STEEL[2])
	g:rect(19, 27, 2, 1, TEAM[2])

	-- Вышка: тонкая башня, остеклённая кабина и маяк на крыше.
	b.tower(g, 52, 22, 3, 12, STEEL)
	g:rect(46, 4, 13, 7, INK)
	g:rect(47, 5, 11, 5, TEAM[1])
	g:rect(47, 5, 11, 1, TEAM[2])
	local sweep = math.cos(TURN * t)
	g:rect(52 + round(sweep * 3), 2, 2, 2, TEAM[3])
	b.lamp(g, 52, 1, 1, pulse(t * 2))
	b.lamp(g, 42, 24, 2, pulse(t, 0.5))
end)
