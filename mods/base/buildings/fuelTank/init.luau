--!strict
-- Топливные баки.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 200,
	inventory = 300,
	accepts = { "fuel" },
	stores = true,
	requires = { "distillery" },
	menu = 16,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
