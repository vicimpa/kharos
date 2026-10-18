--!strict
-- Урановый контейнер.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

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
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
