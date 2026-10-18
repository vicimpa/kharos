--!strict
-- Дешёвая стена не расширяет зону: иначе цепочкой стен можно было бы бесплатно протянуть контроль через карту.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Стена",
	about = "Дешёвая стена не расширяет зону: иначе цепочкой стен можно было бы бесплатно протянуть контроль через карту.",
	width = 1,
	height = 1,
	cost = 30,
	hp = 400,
	defense = true,
	expand = 0,
	isolated = true,
	requires = { "command" },
	research = "walls",
	menu = 36,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
