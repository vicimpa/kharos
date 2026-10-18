--!strict
-- Кремниевый завод.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 3,
	height = 2,
	cost = 400,
	power = -4,
	inventory = 60,
	refines = "siliconOre",
	accepts = { "siliconOre", "silicon" },
	limits = { siliconOre = 30, silicon = 30 },
	requires = { "generator" },
	research = "siliconOre",
	menu = 5,
	-- Раздел сетки строителя.
	section = "industry",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
