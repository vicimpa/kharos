--!strict
-- Урановый контейнер.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 1,
	height = 1,
	cost = 300,
	inventory = 60,
	accepts = { "uranium" },
	stores = true,
	requires = { "uraniumMill" },
	menu = 19,
	-- Раздел сетки строителя.
	section = "storage",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
