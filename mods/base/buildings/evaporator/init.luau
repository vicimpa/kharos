--!strict
-- Выпарка лития из рассола солончаков и урановая фабрика: второй слой, база работает и без них.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 3,
	height = 2,
	cost = 500,
	power = -5,
	inventory = 60,
	refines = "lithiumOre",
	accepts = { "lithiumOre", "lithium" },
	limits = { lithiumOre = 30, lithium = 30 },
	requires = { "generator" },
	research = "lithiumOre",
	menu = 8,
	-- Раздел сетки строителя.
	section = "industry",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
