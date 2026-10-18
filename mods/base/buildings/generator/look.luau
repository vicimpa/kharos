--!strict
-- Электростанция, 2×2: реактор в кольце огней и два бака, от которых по трубам идёт топливо. Под нагрузкой огни кольца
-- бегут и по трубам идёт топливо; станция в запасе, которой питать нечего, стоит тёмной и чуть дышит одной лампой.

local b = require("lib/buildings")

local STEEL, IRON, RUST, TEAM, INK = b.STEEL, b.IRON, b.RUST, b.TEAM, b.INK
local TURN, FRAMES = b.TURN, b.FRAMES

return b.look(2, 2, function(g, t: number, working: boolean)
	b.slab(g, 0, 1, 32, 31, 3, STEEL)
	g:rect(3, 4, 26, 22, STEEL[0])
	g:rect(4, 5, 25, 21, STEEL[1])
	g:rect(4, 27, 7, 1, RUST[1])
	g:rect(21, 27, 7, 1, RUST[1])

	-- Трубы от баков к реактору; под нагрузкой по ним бежит порция топлива.
	local step = math.floor(t * FRAMES) % 8
	for _, y in { 8, 20 } do
		g:rect(8, y - 1, 10, 3, INK)
		g:rect(8, y, 10, 1, RUST[1])
		if working then
			g:rect(9 + step, y, 2, 1, TEAM[3])
		end
		b.tower(g, 6, y + 1, 3, 2, IRON)
	end

	b.tower(g, 21, 17, 9, 4, STEEL)
	local LIGHTS = 6
	for i = 0, LIGHTS - 1 do
		local angle = (i / LIGHTS) * TURN
		local x = b.round(21 + math.cos(angle) * 6.5)
		local y = b.round(13 + math.sin(angle) * 6.5)
		b.bulb(g, x - 1, y - 1, if working then b.chase(t, i / LIGHTS) else 0)
	end
	b.lamp(g, 21, 13, 3, if working then b.pulse(t * 2) else 0.12 + 0.1 * b.pulse(t))
end, { working = true })
