--!strict
-- Ворота.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.gate",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.gate",
	width = 1,
	height = 1,
	cost = 90,
	hp = 400,
	defense = true,
	expand = 0,
	isolated = true,
	gate = true,
	requires = { "command" },
	research = "gates",
	menu = 37,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
