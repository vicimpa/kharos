--!strict
-- Стеллаж стержней.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 1,
	height = 1,
	cost = 300,
	inventory = 40,
	accepts = { "rods" },
	stores = true,
	requires = { "rodPlant" },
	menu = 23,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
