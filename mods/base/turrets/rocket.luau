--!strict
-- Турель rocket.
-- Данные — packages/base/data/turrets.json, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 4,
	radius = 0.2,
	weapon = "launcher",
}

kind.entity = units.turretEntity
kind.look = units.turretLook("rocket")

return kind
