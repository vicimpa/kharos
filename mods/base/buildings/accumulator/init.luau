--!strict
-- Накопитель держит минуту работы электростанции: база переживает снесённую станцию или перегруз, пока его хватает.
-- Строится из лития: это его работа.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 400,
	materials = { lithium = 20 },
	battery = { capacity = 600, rate = 10 },
	requires = { "generator" },
	research = "accumulators",
	menu = 25,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
