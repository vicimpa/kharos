--!strict
-- Хранилища: по одному на каждый ресурс и каждое изделие. Стройблоки громоздкие; боеприпасов делают много, и бункер
-- под них вместительный; компоненты дорогие и мелкие.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.metalYard",
	about = "Хранилища: по одному на каждый ресурс и каждое изделие. Стройблоки громоздкие; боеприпасов делают много, и бункер под них вместительный; компоненты дорогие и мелкие.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.metalYard",
	width = 3,
	height = 2,
	cost = 150,
	inventory = 400,
	accepts = { "metal" },
	stores = true,
	requires = { "smelter" },
	menu = 14,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
