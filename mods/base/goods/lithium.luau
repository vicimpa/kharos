--!strict
-- Груз: литий.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "resource",
	order = 5,
	color = 0xf59ac0,
	-- Литий и уран — второй слой, а не обязательный набор: база без них работает. Литий идёт на накопители энергии. Литий с орбиты продают только тому, кто изучил его выпарку.
	price = 30,
	-- Без этой темы с орбиты не купить.
	research = "lithiumOre",
}

kind.look = goods.look("lithium", kind.data.color)

return kind
