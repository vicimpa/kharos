--!strict
-- Генератор материи — базовый доход: превращает энергию в кредиты. Первая электростанция окупает его быстро, дальше
-- теснота делает каждый следующий всё дороже. Он страховка на случай, когда линий добычи нет (§4.3 шаг 3): одной
-- электростанции хватает на два генератора.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 250,
	power = -3,
	income = 1.5,
	crowding = true,
	requires = { "generator" },
	menu = 2,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
