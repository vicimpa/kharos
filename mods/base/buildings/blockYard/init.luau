--!strict
-- Склад стройблоков.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 150,
	inventory = 200,
	accepts = { "blocks" },
	stores = true,
	requires = { "blockPlant" },
	menu = 20,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
