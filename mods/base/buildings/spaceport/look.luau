--!strict
-- Космопорт, 3×3 — перенос spaceport из buildingArt.ts: посадочная площадка с разметкой и бегущими огнями, сбоку —
-- диспетчерская башня.

local b = require("lib/buildings")

local STEEL, IRON, INK, GOLD = b.STEEL, b.IRON, b.INK, b.GOLD
local TURN, round, pulse, chase = b.TURN, b.round, b.pulse, b.chase

return b.look(3, 3, function(g, t: number)
	b.slab(g, 0, 1, 48, 47, 3, STEEL)
	g:rect(3, 4, 42, 38, IRON[0])
	g:rect(4, 5, 41, 37, IRON[1])
	-- Посадочный круг с крестом.
	g:ring(22, 24, 15, 2, GOLD[0])
	g:ring(22, 24, 8, 1, IRON[3])
	g:rect(21, 12, 2, 24, IRON[3])
	g:rect(10, 23, 24, 2, IRON[3])
	g:circle(22, 24, 3, INK)
	g:circle(22, 24, 2, GOLD[1])
	-- Огни по кругу бегут к центру захода.
	local LIGHTS = 8
	for i = 0, LIGHTS - 1 do
		local angle = (i / LIGHTS) * TURN
		b.bulb(g, round(22 + math.cos(angle) * 18) - 1, round(24 + math.sin(angle) * 17) - 1, chase(t, i / LIGHTS))
	end
	-- Диспетчерская.
	b.tower(g, 41, 12, 4, 9, STEEL)
	b.lamp(g, 41, 2, 2, pulse(t * 2))
end)
