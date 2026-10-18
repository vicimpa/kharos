--!strict
-- Груз: топливо. Данные — packages/base/data/resources.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.fuel",
		kind = "resource",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 3,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0xffc93c,
		-- Цена единицы при продаже через космопорт.
		price = 12,
	},
	look = goods.look("fuel", 0xffc93c),
}
