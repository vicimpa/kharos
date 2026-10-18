--!strict
-- Реактор даёт шесть электростанций на 9 тайлах вместо 24 и жжёт стержень в минуту — около 90 кредитов сырья.
-- Разрушенный с топливом взрывается: его ставят за стеной и в стороне.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Реактор",
	about = "Реактор даёт шесть электростанций на 9 тайлах вместо 24 и жжёт стержень в минуту — около 90 кредитов сырья. Разрушенный с топливом взрывается: его ставят за стеной и в стороне.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Даёт 60 энергии, пока горит стержень: один в минуту, стержни подвозят грузовики. Выключенный стержни бережёт. Разрушенный с топливом взрывается и бьёт всех вокруг — ставь за стеной и в стороне",
	width = 3,
	height = 3,
	cost = 2500,
	power = 60,
	materials = { blocks = 10, parts = 10 },
	inventory = 4,
	accepts = { "rods" },
	burns = { good = "rods", seconds = 60 },
	meltdown = { radius = 4, damage = 600 },
	requires = { "uraniumMill" },
	research = "atom",
	menu = 26,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
