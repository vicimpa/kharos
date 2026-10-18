--!strict
-- Пулемётная турель: серое кольцо наведения — основание; само вращающееся оружие рисуется поверх отдельной сущностью.

local b = require("lib/buildings")

return b.look(1, 1, function(g, t: number)
	b.emplacement(g, t, b.IRON[3])
end)
