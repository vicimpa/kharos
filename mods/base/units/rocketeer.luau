--!strict
-- Ракетчик.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	speed = 2.6,
	turn = 10,
	radius = 0.3,
	cost = 120,
	buildTime = 5,
	kind = "infantry",
	hp = 40,
	weapon = "launcher",
	research = "rockets",
	ammo = 20,
	supply = 1,
}

kind.entity = units.entity
kind.look = units.look("rocketeer", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
