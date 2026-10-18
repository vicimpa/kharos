--!strict
-- Разрядник: тяжёлое шасси с разрядной башней. Катушку собирают из компонентов: в них харит, и без цеха её не сделать.
-- Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, IRON, ENERGY = units.INK, units.IRON, units.ENERGY

-- Разрядник: тяжёлое шасси с погоном и кожухами питания. Катушка — отдельная турель arc.
local function draw(p, team, phase)
	units.heavyHull(p, team, phase)
	for _, side in { -3.5, 3.5 } do p.bar(5, 9, side, 2, ENERGY[0]) end
	p.dot(0, 0, 6.6, INK)
	p.dot(0, 0, 5.8, IRON[1])
end

local kind = {}

kind.data = {
	speed = 2,
	turn = 2.5,
	radius = 0.7,
	cost = 700,
	buildTime = 16,
	kind = "heavy",
	hp = 500,
	materials = { metal = 15, silicon = 6, parts = 3 },
	research = "arcs",
	mounts = { { turret = "arc", along = 0, across = 0 } },
	supply = 3,
	motor = "heavy",
	pitch = 1.06,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "tracks",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -7.5, 7.5 }, width = 4 },
	lights = {
		lamps = { { 10, -4, 2.5 }, { 10, 4, 2.5 } },
		beam = { along = 13, length = 60, near = 6, spread = 0.3, level = 1 },
	},
})

return kind
