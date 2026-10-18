--!strict
-- Штурмовик. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON, HAZARD = units.INK, units.STEEL, units.IRON, units.HAZARD

-- Штурмовик: фюзеляж, крылья с ракетными блоками и хвост.
local function draw(p, team)
	p.beam(-1, -11, 11, 6, INK)
	p.beam(-1, -10, 10, 4, STEEL[1])
	p.beam(-2, -10, 10, 1, STEEL[3])
	p.beam(-1, -10, -7, 4, team[0])
	p.beam(-1, 7, 10, 4, team[0])
	for _, side in { -6.5, 6.5 } do
		p.bar(-2, 6, side, 3.4, INK)
		p.bar(-1, 5, side, 1.6, IRON[3])
		p.dot(5.5, side, 0.9, HAZARD[2])
	end
	p.beam(-9, -4, 4, 3.4, INK)
	p.beam(-9, -3, 3, 1.6, STEEL[2])
	p.bar(-10, 10, 0, 6, INK)
	p.bar(-9, 9, 0, 4, STEEL[2])
	p.bar(-9, 9, -1.5, 1, STEEL[3])
	p.bar(4, 8, 0, 2.6, team[2])
end

local kind = {}

kind.data = {
	speed = 5,
	turn = 3,
	radius = 0.55,
	cost = 500,
	buildTime = 12,
	kind = "air",
	hp = 200,
	weapon = "launcher",
	materials = { metal = 12, silicon = 4, fuel = 8 },
	research = "gunship",
	ammo = 50,
	supply = 3,
	motor = "rotor",
	pitch = 0.92,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "air",
	draw = draw,
	mounts = kind.data.mounts,
	lights = {
		lamps = { { 10, 0, 2.5 } },
		beam = { along = 12, length = 64, near = 4, spread = 0.35, level = 1 },
	},
})

return kind
