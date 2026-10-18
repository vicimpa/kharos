--!strict
-- Аэродром выпускает летающих: им нужно топливо, бомбардировщику ещё и техцентр.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 4,
	height = 3,
	cost = 500,
	power = -4,
	materials = { metal = 15, blocks = 5 },
	produces = { "airTruck", "drone", "gunship", "bomber" },
	rearms = true,
	requires = { "radar" },
	research = "aviation",
	menu = 31,
	-- Раздел сетки строителя.
	section = "military",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
