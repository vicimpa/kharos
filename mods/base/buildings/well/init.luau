--!strict
-- Колодец.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
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
