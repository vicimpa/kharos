--!strict
-- Груз: литий. Данные — packages/base/data/resources.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "Литий",
		kind = "resource",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 5,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0xf59ac0,
		-- Литий и уран — второй слой, а не обязательный набор: база без них работает. Литий идёт на накопители энергии. Литий с орбиты продают только тому, кто изучил его выпарку.
		-- Цена единицы при продаже через космопорт.
		price = 30,
		-- Без этой темы с орбиты не купить.
		research = "lithiumOre",
	},
	look = goods.look("lithium", 0xf59ac0),
}
