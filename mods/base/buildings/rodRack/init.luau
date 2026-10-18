--!strict
-- Стеллаж стержней.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Стеллаж стержней",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Хранит топливные стержни зоны",
	width = 1,
	height = 1,
	cost = 300,
	inventory = 40,
	accepts = { "rods" },
	stores = true,
	requires = { "rodPlant" },
	menu = 23,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
