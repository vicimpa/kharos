--!strict
-- Ветряная ловушка.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 300,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
