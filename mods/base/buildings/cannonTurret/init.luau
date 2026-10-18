--!strict
-- Пушечная турель.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Пушечная турель",
	width = 1,
	height = 1,
	cost = 450,
	hp = 500,
	defense = true,
	inventory = 120,
	accepts = { "ammo" },
	ammo = true,
	mounts = { { turret = "cannon", along = 0, across = 0 } },
	requires = { "radar" },
	research = "armor",
	menu = 40,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
