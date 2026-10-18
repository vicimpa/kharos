--!strict
-- Разрядник: тяжёлое шасси с разрядной башней. Катушку собирают из компонентов: в них харит, и без цеха её не сделать.
-- Мотор и тон — sounds/motors, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	speed = 2,
	turn = 2.5,
	radius = 0.7,
	cost = 700,
	buildTime = 16,
	kind = "heavy",
	hp = 500,
	materials = { metal = 15, silicon = 6, parts = 3 },
	research = "arcs",
	mounts = { { turret = "arc", along = 0, across = 0 } },
	supply = 3,
	motor = "heavy",
	pitch = 1.06,
}

kind.entity = units.entity
kind.look = units.look("tesla", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
