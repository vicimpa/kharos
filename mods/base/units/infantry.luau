--!strict
-- Пехотинец. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL = units.INK, units.STEEL

-- Пехотинец: плечи, голова и оружие.
local function draw(p, team, phase)
	units.legs(p, phase)
	p.beam(0, -3.5, 3.5, 5, INK)
	p.beam(0, -2.5, 2.5, 3, team[0])
	p.bar(0, 5, 2.5, 1.2, INK)
	p.dot(0.5, 0, 2, INK)
	p.dot(0.5, 0, 1.2, STEEL[4])
end

local kind = {}

kind.data = {
	speed = 3,
	turn = 10,
	radius = 0.3,
	cost = 60,
	buildTime = 3,
	kind = "infantry",
	hp = 50,
	weapon = "rifle",
	ammo = 10,
	supply = 1,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "legs",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -1.5, 1.5 }, width = 1.4 },
	lights = {
		lamps = { { 5, 2.5, 1.5 } },
		beam = { along = 7, length = 36, near = 1.5, spread = 0.22, level = 0.9 },
	},
})

return kind
