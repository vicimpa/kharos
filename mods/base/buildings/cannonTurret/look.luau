--!strict
-- Пушечная турель: золотое кольцо тяжёлого орудия — перенос cannonTurret из buildingArt.ts: основание; само вращающееся оружие рисуется поверх отдельной сущностью.

local b = require("lib/buildings")

return b.look(1, 1, function(g, t: number)
	b.emplacement(g, t, b.GOLD[1])
end)
