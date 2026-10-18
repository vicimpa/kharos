--!strict
-- Станция поставки: здесь машины снабжения грузятся вчетверо быстрее, чем у хранилищ сети. Без неё машину снабжения
-- не заказать.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.supplyDepot",
	about = "Станция поставки: здесь машины снабжения грузятся вчетверо быстрее, чем у хранилищ сети. Без неё машину снабжения не заказать.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.supplyDepot",
	width = 3,
	height = 2,
	cost = 350,
	materials = { blocks = 6 },
	inventory = 300,
	accepts = { "ammo" },
	depot = true,
	beam = { radius = 3, rate = 40, give = true },
	requires = { "factory" },
	research = "vehicles",
	menu = 34,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
