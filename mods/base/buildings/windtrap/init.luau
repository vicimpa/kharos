--!strict
-- Ветряная ловушка.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Ветряная ловушка",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Ловит влагу из ветра",
	width = 2,
	height = 2,
	cost = 300,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
