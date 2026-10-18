--!strict
-- Завод компонентов.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 300,
	power = -3,
	inventory = 42,
	assembles = "parts",
	accepts = { "silicon", "kharite", "parts" },
	limits = { silicon = 8, kharite = 4, parts = 30 },
	requires = { "siliconWorks" },
	research = "parts",
	menu = 12,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
