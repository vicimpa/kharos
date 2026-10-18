--!strict
-- Тяжёлые: медленные, крепкие и дорогие. Весь второй тир собирают с компонентами: в них харит, и без его месторождения
-- и цеха верхней техники нет. Танк бьёт ядрами из башни: она поворачивается сама, и стрелять можно на ходу. Кремний его
-- прицела — в компонентах. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL = units.INK, units.STEEL

-- Танк: гусеницы, корпус и погон под башню. Башня — отдельная турель cannon.
local function draw(p, team, phase)
	units.heavyHull(p, team, phase)
	p.bar(6, 9, 0, 8, STEEL[2])
	p.beam(7.5, -3, 3, 1, STEEL[0])
	p.dot(-1, 0, 6.4, INK)
	p.dot(-1, 0, 5.6, STEEL[0])
end

local kind = {}

kind.data = {
	speed = 2.2,
	turn = 2.5,
	radius = 0.7,
	cost = 600,
	buildTime = 14,
	kind = "heavy",
	hp = 450,
	materials = { metal = 20, parts = 2 },
	research = "armor",
	ammo = 60,
	mounts = { { turret = "cannon", along = -0.06, across = 0 } },
	supply = 3,
	motor = "heavy",
}

kind.entity = units.entity
kind.look = units.look({
	gait = "tracks",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -7.5, 7.5 }, width = 4 },
	lights = {
		lamps = { { 10, -4, 2.5 }, { 10, 4, 2.5 } },
		beam = { along = 15, length = 60, near = 6, spread = 0.3, level = 1 },
	},
})

return kind
