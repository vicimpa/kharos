--!strict
-- Урановая фабрика.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 800,
	power = -8,
	inventory = 60,
	refines = "uraniumOre",
	accepts = { "uraniumOre", "uranium" },
	limits = { uraniumOre = 30, uranium = 30 },
	requires = { "generator" },
	research = "uraniumOre",
	menu = 9,
	-- Раздел сетки строителя.
	section = "industry",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
