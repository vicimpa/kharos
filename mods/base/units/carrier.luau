--!strict
-- Носитель: колёсное шасси танка без своего оружия — на нём три ракетные турели и ремонтная. Ремонтной нужен
-- компонент.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "Носитель",
	about = "Носитель: колёсное шасси танка без своего оружия — на нём три ракетные турели и ремонтная. Ремонтной нужен компонент.",
	speed = 3,
	turn = 2.5,
	radius = 0.8,
	cost = 1200,
	buildTime = 20,
	kind = "vehicle",
	hp = 700,
	materials = { metal = 25, silicon = 8, parts = 1 },
	research = "siege",
	ammo = 120,
	mounts = {
		{ turret = "rocket", along = 0.36, across = -0.27 },
		{ turret = "rocket", along = 0.36, across = 0.27 },
		{ turret = "rocket", along = -0.28, across = -0.27 },
		{ turret = "repair", along = -0.28, across = 0.27 },
	},
	supply = 4,
	motor = "diesel",
	pitch = 0.9,
}

kind.entity = units.entity
kind.look = units.look("carrier", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
