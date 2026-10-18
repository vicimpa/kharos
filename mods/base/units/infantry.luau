--!strict
-- Пехотинец.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	speed = 3,
	turn = 10,
	radius = 0.3,
	cost = 60,
	buildTime = 3,
	kind = "infantry",
	hp = 50,
	weapon = "rifle",
	ammo = 10,
	supply = 1,
}

kind.entity = units.entity
kind.look = units.look("infantry", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
