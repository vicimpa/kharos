--!strict
-- Ракетная турель: ржаво-красное кольцо — основание; само вращающееся оружие рисуется поверх отдельной сущностью.

local b = require("lib/buildings")

return b.look(1, 1, function(g, t: number)
	b.emplacement(g, t, b.RUST[1])
end)
