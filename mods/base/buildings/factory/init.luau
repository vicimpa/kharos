--!strict
-- Машинный завод: машинки и тяжёлая техника. Строится из стройблоков: военная промышленность требует цеха.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Машинный завод",
	about = "Машинный завод: машинки и тяжёлая техника. Строится из стройблоков: военная промышленность требует цеха.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Выпускает наземную технику и MCV для новых баз",
	width = 3,
	height = 3,
	cost = 450,
	power = -5,
	materials = { blocks = 10 },
	produces = { "buggy", "flak", "lancer", "supplier", "tank", "artillery", "tesla", "carrier", "mcv" },
	requires = { "radar" },
	research = "vehicles",
	menu = 30,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
