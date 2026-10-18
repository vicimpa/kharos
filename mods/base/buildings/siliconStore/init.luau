--!strict
-- Склад кремния.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.siliconStore",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.siliconStore",
	width = 2,
	height = 2,
	cost = 150,
	inventory = 300,
	accepts = { "silicon" },
	stores = true,
	requires = { "siliconWorks" },
	menu = 15,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
