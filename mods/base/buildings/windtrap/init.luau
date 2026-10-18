--!strict
-- Ветряная ловушка.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.windtrap",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.windtrap",
	width = 2,
	height = 2,
	cost = 300,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
