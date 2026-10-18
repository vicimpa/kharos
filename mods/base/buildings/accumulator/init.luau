--!strict
-- Накопитель держит минуту работы электростанции: база переживает снесённую станцию или перегруз, пока его хватает.
-- Строится из лития: это его работа.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Накопитель",
	about = "Накопитель держит минуту работы электростанции: база переживает снесённую станцию или перегруз, пока его хватает. Строится из лития: это его работа.",
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
