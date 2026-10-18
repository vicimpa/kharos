--!strict
-- Сейф харита, 1×1: бронированный куб с толстой дверью и замком, сквозь щели светится груз.

local b = require("lib/buildings")

local IRON, INK, HAZARD = b.IRON, b.INK, b.HAZARD
local pulse = b.pulse

return b.look(1, 1, function(g, t: number)
	local tint = b.accent(b.goodColor("kharite"))
	b.slab(g, 0, 1, 16, 15, 2, IRON)
	g:rect(2, 3, 12, 9, IRON[0])
	g:rect(3, 4, 10, 7, IRON[2])
	g:rect(3, 4, 10, 1, IRON[3])
	-- Щели светятся цветом харита.
	local glow = 0.5 + 0.5 * pulse(t)
	g:rect(3, 7, 10, 1, if glow > 0.6 then tint[2] else tint[1])
	g:light(8, 7, 3, 0.3 + 0.4 * glow)
	-- Замок.
	g:circle(8, 7, 2, INK)
	g:circle(8, 7, 1, HAZARD[1])
end)
