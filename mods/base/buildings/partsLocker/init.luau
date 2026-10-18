--!strict
-- Шкаф компонентов.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Шкаф компонентов",
	width = 1,
	height = 1,
	cost = 200,
	inventory = 60,
	accepts = { "parts" },
	stores = true,
	requires = { "partsPlant" },
	menu = 22,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
