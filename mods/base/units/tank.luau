--!strict
-- Тяжёлые: медленные, крепкие и дорогие. Весь второй тир собирают с компонентами: в них харит, и без его
-- месторождения и цеха верхней техники нет. Танк бьёт ядрами из башни: она поворачивается сама, и стрелять можно на
-- ходу. Кремний его прицела — в компонентах.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "Танк",
	about = "Тяжёлые: медленные, крепкие и дорогие. Весь второй тир собирают с компонентами: в них харит, и без его месторождения и цеха верхней техники нет. Танк бьёт ядрами из башни: она поворачивается сама, и стрелять можно на ходу. Кремний его прицела — в компонентах.",
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
kind.look = units.look("tank", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
