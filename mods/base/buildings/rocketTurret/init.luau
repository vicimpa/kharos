--!strict
-- Ракетная турель.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 1,
	height = 1,
	cost = 300,
	hp = 400,
	defense = true,
	inventory = 120,
	accepts = { "ammo" },
	ammo = true,
	mounts = { { turret = "rocket", along = 0, across = 0 } },
	requires = { "radar" },
	research = "rockets",
	menu = 39,
	-- Раздел сетки строителя.
	section = "defense",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
