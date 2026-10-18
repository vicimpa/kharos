--!strict
-- Зенитка: быстрая машина со спаренной автопушкой, бьёт только по воздуху — далеко и сильно.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "units.flak",
	about = "Зенитка: быстрая машина со спаренной автопушкой, бьёт только по воздуху — далеко и сильно.",
	speed = 5,
	turn = 4.5,
	radius = 0.5,
	cost = 350,
	buildTime = 8,
	kind = "vehicle",
	hp = 170,
	weapon = "flak",
	materials = { metal = 8 },
	sight = 10,
	ammo = 40,
	supply = 2,
	motor = "petrol",
}

kind.entity = units.entity
kind.look = units.look("flak", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
