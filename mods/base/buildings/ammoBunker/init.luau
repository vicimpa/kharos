--!strict
-- Бункер боеприпасов.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 1,
	cost = 200,
	inventory = 300,
	accepts = { "ammo" },
	stores = true,
	requires = { "ammoPlant" },
	menu = 21,
	-- Раздел сетки строителя.
	section = "storage",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
