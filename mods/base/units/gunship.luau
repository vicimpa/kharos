--!strict
-- Штурмовик.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	speed = 5,
	turn = 3,
	radius = 0.55,
	cost = 500,
	buildTime = 12,
	kind = "air",
	hp = 200,
	weapon = "launcher",
	materials = { metal = 12, silicon = 4, fuel = 8 },
	research = "gunship",
	ammo = 50,
	supply = 3,
	motor = "rotor",
	pitch = 0.92,
}

kind.entity = units.entity
kind.look = units.look("gunship", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
