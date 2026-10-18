--!strict
-- Сейф харита.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 1,
	height = 1,
	cost = 250,
	inventory = 60,
	accepts = { "kharite" },
	stores = true,
	requires = { "enricher" },
	menu = 17,
	-- Раздел сетки строителя.
	section = "storage",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
