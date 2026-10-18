--!strict
-- Танковая башня: тяжёлая, поворачивается медленно, ядро вылетает с конца длинного ствола. Чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 2,
	radius = 0.85,
	weapon = "cannon",
}

kind.entity = units.turretEntity
kind.look = units.turretLook("cannon")

return kind
