--!strict
-- Казармы.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 3,
	height = 2,
	cost = 250,
	power = -2,
	produces = { "infantry", "rocketeer", "flamer" },
	requires = { "radar" },
	research = "infantry",
	menu = 29,
	-- Раздел сетки строителя.
	section = "military",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
