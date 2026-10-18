--!strict
-- Электростанция.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.generator",
	about = "Электростанция.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.generator",
	width = 2,
	height = 2,
	cost = 300,
	power = 10,
	requires = { "command" },
	menu = 1,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
