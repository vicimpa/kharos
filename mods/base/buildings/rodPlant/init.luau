--!strict
-- Завод стержней.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
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
