--!strict
-- Электростанция.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
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
