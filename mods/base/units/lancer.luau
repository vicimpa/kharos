--!strict
-- Лазеру нужен кремний. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL = units.INK, units.STEEL

-- Лазерная машина: излучатель на шасси.
local function draw(p, team, phase)
	units.wheels(p, 4.5, 4.5, phase)
	p.bar(-7, 6, 0, 8, INK)
	p.bar(-6, 5, 0, 6, STEEL[1])
	p.bar(-6, 5, -2.5, 1, STEEL[3])
	p.bar(-6, -4, 0, 6, team[0])
	p.bar(-2, 8, 0, 3.4, INK)
	p.bar(-1, 7, 0, 1.6, STEEL[4])
	p.dot(8, 0, 1.6, 0xff4d6d)
	p.dot(-2, 0, 3.2, INK)
	p.dot(-2, 0, 2.2, team[1])
end

local kind = {}

kind.data = {
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
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -4.5, 4.5 }, width = 3 },
	lights = {
		lamps = { { 6, -2.5, 2 }, { 6, 2.5, 2 } },
		beam = { along = 10, length = 52, near = 4, spread = 0.3, level = 1 },
	},
})

return kind
