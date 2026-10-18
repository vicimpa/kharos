--!strict
-- Дрон. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, IRON = units.INK, units.IRON

-- Дрон: четыре винта крестом и маленький корпус.
local function draw(p, team)
	for _, pair in { { 4, 4 }, { 4, -4 }, { -4, 4 }, { -4, -4 } } do
		local along, across = pair[1], pair[2]
		p.line(0, 0, along, across, 2.4, INK)
		p.line(0, 0, along, across, 1, IRON[2])
		p.dot(along, across, 2.8, INK)
		p.dot(along, across, 1.8, IRON[3])
		p.dot(along, across, 0.7, IRON[0])
	end
	p.bar(0, 6, 0, 1.6, INK)
	p.dot(0, 0, 3.2, INK)
	p.dot(0, 0, 2.2, team[0])
	p.dot(0.5, -0.5, 1, team[2])
end

local kind = {}

kind.data = {
	speed = 7.5,
	turn = 6,
	radius = 0.35,
	cost = 220,
	buildTime = 6,
	kind = "air",
	hp = 70,
	weapon = "machinegun",
	materials = { silicon = 3, fuel = 4 },
	ammo = 20,
	supply = 2,
	motor = "props",
}

kind.entity = units.entity
kind.look = units.look({
	gait = "air",
	draw = draw,
	mounts = kind.data.mounts,
	lights = {
		lamps = { { 5, 0, 1.5 } },
		beam = { along = 7, length = 40, near = 2, spread = 0.3, level = 0.8 },
	},
})

return kind
