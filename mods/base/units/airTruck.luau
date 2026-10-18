--!strict
-- Летающие: им нужно топливо. Летающий грузовик: везёт меньше обычного, зато вдвое быстрее и напрямик — над болотами и
-- горами. Его сбивает ПВО. Мотор и тон — sounds/motors, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	speed = 7,
	turn = 5,
	radius = 0.45,
	cost = 300,
	buildTime = 10,
	kind = "air",
	hp = 100,
	sight = 8,
	inventory = 10,
	hauls = true,
	beam = { radius = 2, rate = 10, give = true, take = true },
	materials = { fuel = 4 },
	supply = 2,
	motor = "rotor",
}

kind.entity = units.entity
kind.look = units.look("airTruck", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
