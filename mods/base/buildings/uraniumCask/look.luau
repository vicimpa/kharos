--!strict
-- Урановый контейнер, 1×1: свинцовый бочонок с крышкой на болтах и зелёной меткой радиации.

local b = require("lib/buildings")

local IRON, INK = b.IRON, b.INK

return b.look(1, 1, function(g, t: number)
	local tint = b.accent(b.goodColor("uranium"))
	b.slab(g, 0, 1, 16, 15, 2, IRON)
	g:circle(8, 7, 6, INK)
	g:circle(8, 7, 5, IRON[1])
	g:circle(7, 6, 4, IRON[2])
	for _, at in { { 4, 7 }, { 12, 7 }, { 8, 3 }, { 8, 11 } } do
		g:rect(at[1], at[2], 1, 1, IRON[4])
	end
	local glow = 0.5 + 0.5 * b.pulse(t)
	g:circle(8, 7, 2, INK)
	g:circle(8, 7, 1.5, if glow > 0.6 then tint[2] else tint[1])
	g:light(8, 7, 3, 0.2 + 0.3 * glow)
end)
