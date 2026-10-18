--!strict
-- Урановая фабрика.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.uraniumMill",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.uraniumMill",
	width = 2,
	height = 2,
	cost = 800,
	power = -8,
	inventory = 60,
	refines = "uraniumOre",
	accepts = { "uraniumOre", "uranium" },
	limits = { uraniumOre = 30, uranium = 30 },
	requires = { "generator" },
	research = "uraniumOre",
	menu = 9,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
