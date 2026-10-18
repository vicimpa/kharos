--!strict
-- Ракетчик. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON, HAZARD = units.INK, units.STEEL, units.IRON, units.HAZARD

-- Ракетчик: пехотинец с трубой на плече.
local function draw(p, team, phase)
	units.legs(p, phase)
	p.beam(0, -3.5, 3.5, 5, INK)
	p.beam(0, -2.5, 2.5, 3, team[0])
	p.bar(-4, 6, -2.5, 3.2, INK)
	p.bar(-3, 5, -2.5, 1.6, IRON[3])
	p.dot(5.5, -2.5, 1, HAZARD[2])
	p.dot(0.5, 0.5, 2, INK)
	p.dot(0.5, 0.5, 1.2, STEEL[4])
end

local kind = {}

kind.data = {
	speed = 2.6,
	turn = 10,
	radius = 0.3,
	cost = 120,
	buildTime = 5,
	kind = "infantry",
	hp = 40,
	weapon = "launcher",
	research = "rockets",
	ammo = 20,
	supply = 1,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "legs",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -1.5, 1.5 }, width = 1.4 },
	lights = {
		lamps = { { 4, 2.5, 1.5 } },
		beam = { along = 7, length = 36, near = 1.5, spread = 0.22, level = 0.9 },
	},
})

return kind
