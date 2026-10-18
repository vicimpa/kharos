--!strict
-- Лазеру нужен кремний.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "units.lancer",
	about = "Лазеру нужен кремний.",
	speed = 4.5,
	turn = 4.5,
	radius = 0.45,
	cost = 350,
	buildTime = 9,
	kind = "vehicle",
	hp = 180,
	weapon = "laser",
	materials = { metal = 8, silicon = 4 },
	research = "lasers",
	supply = 2,
	motor = "petrol",
	pitch = 0.95,
}

kind.entity = units.entity
kind.look = units.look("lancer", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
