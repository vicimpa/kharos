--!strict
-- Заводы изделий: каждый собирает своё изделие из ресурсов (§3.7 design.md). Склад общий на сырьё и готовое.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 300,
	power = -3,
	inventory = 42,
	assembles = "blocks",
	accepts = { "metal", "silicon", "blocks" },
	limits = { metal = 8, silicon = 4, blocks = 30 },
	requires = { "smelter" },
	research = "blocks",
	menu = 10,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
