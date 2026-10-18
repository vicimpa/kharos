--!strict
-- Строитель сам подвозит материалы на свою стройку, если их никто не везёт: кузов на 10 и луч, как у грузовика. Мотор и
-- тон — sounds/motors.

local units = require("lib/units")

local INK, IRON, HAZARD = units.INK, units.IRON, units.HAZARD

-- Строитель: небольшая колёсная машина со стрелой.
local function draw(p, team, phase)
	for _, side in { -4, 4 } do
		for _, wheel in { -3.5, 3.5 } do units.tire(p, wheel, side, 2, 3, phase) end
	end
	p.bar(-6, 6, 0, 8, INK)
	p.bar(-5, 5, 0, 6, HAZARD[1])
	p.bar(-5, 5, -2.5, 1, HAZARD[2])
	p.bar(-5, -3, 0, 6, HAZARD[0])
	p.bar(2, 4, 0, 4, team[1])
	p.bar(-1, 8, 2, 2, INK)
	p.dot(8, 2, 1.5, IRON[3])
end

local kind = {}

kind.data = {
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
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -4, 4 }, width = 3 },
	lights = {
		lamps = { { 6, -2, 2 }, { 6, 2, 2 } },
		beam = { along = 10, length = 52, near = 4, spread = 0.3, level = 1 },
	},
})

return kind
