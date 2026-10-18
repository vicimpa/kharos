--!strict
-- Склад лития.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 1,
	cost = 200,
	inventory = 120,
	accepts = { "lithium" },
	stores = true,
	requires = { "evaporator" },
	menu = 18,
	-- Раздел сетки строителя.
	section = "storage",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
