--!strict
-- Хранилища: по одному на каждый ресурс и каждое изделие. Стройблоки громоздкие; боеприпасов делают много, и бункер
-- под них вместительный; компоненты дорогие и мелкие.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
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
