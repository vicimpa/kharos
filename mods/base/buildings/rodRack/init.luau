--!strict
-- Стеллаж стержней.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.rodRack",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.rodRack",
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
