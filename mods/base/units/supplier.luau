--!strict
-- Машина снабжения: хвост армии. Медленная и крупная, с пулемётчиком против разведки; раздаёт патроны своим вокруг, а
-- сама берёт их у грузовиков в поле, из хранилищ сети и быстрее всего — на станции поставки. Отсеки под топливо и
-- аккумуляторы добавятся в accepts, когда их начнут тратить. Мотор и тон — sounds/motors, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	speed = 2,
	turn = 2.2,
	radius = 0.75,
	cost = 450,
	buildTime = 12,
	kind = "vehicle",
	hp = 400,
	materials = { metal = 12, blocks = 4 },
	sight = 7,
	ammo = 30,
	inventory = 150,
	accepts = { "ammo" },
	supplies = { radius = 6, rate = 10 },
	requires = { "supplyDepot" },
	mounts = { { turret = "gunner", along = 0.3, across = 0 } },
	supply = 2,
	motor = "diesel",
	pitch = 0.85,
}

kind.entity = units.entity
kind.look = units.look("supplier", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
