--!strict
-- Аэродром выпускает летающих: им нужно топливо, бомбардировщику ещё и техцентр.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Аэродром",
	about = "Аэродром выпускает летающих: им нужно топливо, бомбардировщику ещё и техцентр.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Выпускает авиацию: летающие грузовики, дроны, штурмовики и бомбардировщики. Над ним авиация пополняет боеприпасы из хранилищ его сети",
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
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
