--!strict
-- Казармы.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.barracks",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.barracks",
	width = 3,
	height = 2,
	cost = 250,
	power = -2,
	produces = { "infantry", "rocketeer", "flamer" },
	requires = { "radar" },
	research = "infantry",
	menu = 29,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
