--!strict
-- Строитель сам подвозит материалы на свою стройку, если их никто не везёт: кузов на 10 и луч, как у грузовика.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "Строитель",
	about = "Строитель сам подвозит материалы на свою стройку, если их никто не везёт: кузов на 10 и луч, как у грузовика.",
	speed = 4,
	turn = 5,
	radius = 0.45,
	cost = 120,
	buildTime = 5,
	kind = "vehicle",
	hp = 100,
	repair = 5,
	sight = 6,
	inventory = 10,
	beam = { radius = 2, rate = 10, give = true, take = true },
	supply = 1,
	motor = "petrol",
	pitch = 1.12,
}

kind.entity = units.entity
kind.look = units.look("builder", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
