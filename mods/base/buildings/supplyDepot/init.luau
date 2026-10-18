--!strict
-- Станция поставки: здесь машины снабжения грузятся вчетверо быстрее, чем у хранилищ сети. Без неё машину снабжения
-- не заказать.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Станция поставки",
	about = "Станция поставки: здесь машины снабжения грузятся вчетверо быстрее, чем у хранилищ сети. Без неё машину снабжения не заказать.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Держит запас патронов для машин снабжения и грузит их своим лучом вчетверо быстрее хранилищ. Грузовики и трубы держат её полной; по общим заявкам не отдаёт",
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
