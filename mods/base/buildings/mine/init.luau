--!strict
-- Шахта энергии не просит и начинает свою зону: тянуть к месторождению цепочку зданий не нужно. Добытое копится в
-- шахте, пока его не выкачают грузовики.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 300,
	zone = 7,
	extract = true,
	inventory = 60,
	requires = { "generator" },
	research = "prospecting",
	menu = 3,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
