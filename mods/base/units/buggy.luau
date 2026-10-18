--!strict
-- Машинки: быстрые и хрупкие. Багги: за водителем сидит пассажир с миниганом и стреляет во все стороны. Она же
-- разведчик: видит дальше всех на земле.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "Багги",
	about = "Машинки: быстрые и хрупкие. Багги: за водителем сидит пассажир с миниганом и стреляет во все стороны. Она же разведчик: видит дальше всех на земле.",
	speed = 6,
	turn = 5,
	radius = 0.45,
	cost = 250,
	buildTime = 7,
	kind = "vehicle",
	hp = 150,
	materials = { metal = 6 },
	sight = 11,
	ammo = 30,
	mounts = { { turret = "gunner", along = -0.16, across = 0 } },
	supply = 2,
	motor = "petrol",
	pitch = 1.18,
}

kind.entity = units.entity
kind.look = units.look("buggy", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
