--!strict
-- Обогатитель харита.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.enricher",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.enricher",
	width = 2,
	height = 2,
	cost = 650,
	power = -7,
	inventory = 60,
	refines = "khariteOre",
	accepts = { "khariteOre", "kharite" },
	limits = { khariteOre = 30, kharite = 30 },
	requires = { "generator" },
	research = "khariteOre",
	menu = 7,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
