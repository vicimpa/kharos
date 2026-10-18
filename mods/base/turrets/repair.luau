--!strict
-- Турель repair. Чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 4,
	radius = 0.2,
	repair = 5,
}

kind.entity = units.turretEntity
kind.look = units.turretLook("repair")

return kind
