--!strict
-- Нефтеперегонка.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 3,
	cost = 400,
	power = -5,
	inventory = 60,
	refines = "fuelOre",
	accepts = { "fuelOre", "fuel" },
	limits = { fuelOre = 30, fuel = 30 },
	requires = { "generator" },
	research = "fuelOre",
	menu = 6,
	-- Раздел сетки строителя.
	section = "industry",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
