--!strict
-- Дрон.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	speed = 7.5,
	turn = 6,
	radius = 0.35,
	cost = 220,
	buildTime = 6,
	kind = "air",
	hp = 70,
	weapon = "machinegun",
	materials = { silicon = 3, fuel = 4 },
	ammo = 20,
	supply = 2,
	motor = "props",
}

kind.entity = units.entity
kind.look = units.look("drone", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
