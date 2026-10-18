--!strict
-- Колодец.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Колодец",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Вход подземной трубы: связывается со своим колодцем по прямой до 10 тайлов. Под отрезком ездят и строят. Ставится и вне зоны",
	width = 1,
	height = 1,
	cost = 40,
	hp = 250,
	expand = 3,
	sight = 1,
	pipe = "well",
	research = "wells",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
