--!strict
-- Завод стержней.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Завод стержней",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Собирает топливные стержни из урана и металла",
	width = 2,
	height = 2,
	cost = 300,
	power = -3,
	inventory = 42,
	assembles = "rods",
	accepts = { "uranium", "metal", "rods" },
	limits = { uranium = 8, metal = 4, rods = 30 },
	requires = { "uraniumMill" },
	research = "rods",
	menu = 13,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
