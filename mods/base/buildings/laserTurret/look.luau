--!strict
-- Лазерная турель: голубое кольцо излучателя — перенос laserTurret из buildingArt.ts: основание; само вращающееся оружие рисуется поверх отдельной сущностью.

local b = require("lib/buildings")

return b.look(1, 1, function(g, t: number)
	b.emplacement(g, t, b.ARC[1])
end)
