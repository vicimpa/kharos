--!strict
-- Завод боеприпасов.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.ammoPlant",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.ammoPlant",
	width = 2,
	height = 2,
	cost = 300,
	power = -3,
	inventory = 34,
	assembles = "ammo",
	accepts = { "metal", "ammo" },
	limits = { metal = 4, ammo = 30 },
	requires = { "smelter" },
	research = "ammo",
	menu = 11,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
