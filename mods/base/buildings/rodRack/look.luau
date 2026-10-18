--!strict
-- Стеллаж стержней, 1×1: свинцовый пенал с тремя гнёздами, торцы стержней светятся зелёным.

local b = require("lib/buildings")

local IRON, INK = b.IRON, b.INK
local pulse, chase = b.pulse, b.chase

return b.look(1, 1, function(g, t: number)
	local tint = b.accent(b.goodColor("rods"))
	b.slab(g, 0, 1, 16, 15, 2, IRON)
	g:rect(2, 3, 12, 9, INK)
	g:rect(3, 4, 10, 7, IRON[1])
	for i = 0, 2 do
		local x = 4 + i * 3
		g:rect(x, 5, 2, 5, IRON[3])
		g:rect(x, 5, 2, 1, if chase(t, i / 3) > 0.3 then tint[2] else tint[1])
	end
	g:light(8, 7, 2, 0.2 + 0.3 * pulse(t))
end)
