--!strict
-- Артиллерия: гаубица на колёсном лафете. Бьёт дальше турелей, но видит меньше, чем стреляет, — ей нужен разведчик;
-- хрупкая и с мёртвой зоной вблизи, без прикрытия её съедают машинки. Второй тир.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "units.artillery",
	about = "Артиллерия: гаубица на колёсном лафете. Бьёт дальше турелей, но видит меньше, чем стреляет, — ей нужен разведчик; хрупкая и с мёртвой зоной вблизи, без прикрытия её съедают машинки. Второй тир.",
	speed = 2.4,
	turn = 2.2,
	radius = 0.6,
	cost = 800,
	buildTime = 16,
	kind = "vehicle",
	hp = 200,
	weapon = "artillery",
	sight = 8,
	ammo = 80,
	materials = { metal = 16, blocks = 4, parts = 2 },
	research = "siege",
	supply = 3,
	motor = "diesel",
}

kind.entity = units.entity
kind.look = units.look("artillery", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
