--!strict
-- Сейф харита.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Сейф харита",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Хранит харит зоны",
	width = 1,
	height = 1,
	cost = 250,
	inventory = 60,
	accepts = { "kharite" },
	stores = true,
	requires = { "enricher" },
	menu = 17,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
