--!strict
-- Ремонтная станция чинит технику и здания вокруг себя — так же и за ту же цену, что строитель, и тоже не под огнём:
-- это пункт обслуживания в тылу. Пехота рядом поправляется быстрее. Без энергии не работает.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 3,
	height = 3,
	cost = 500,
	power = -3,
	materials = { blocks = 8 },
	repair = 5.5,
	requires = { "factory" },
	research = "repair",
	menu = 33,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
