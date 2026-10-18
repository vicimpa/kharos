--!strict
-- Склад лития.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Склад лития",
	width = 2,
	height = 1,
	cost = 200,
	inventory = 120,
	accepts = { "lithium" },
	stores = true,
	requires = { "evaporator" },
	menu = 18,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
