--!strict
-- Склад кремния.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 150,
	inventory = 300,
	accepts = { "silicon" },
	stores = true,
	requires = { "siliconWorks" },
	menu = 15,
	-- Раздел сетки строителя.
	section = "storage",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
