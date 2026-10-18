--!strict
-- Груз: металл. Данные — packages/base/data/resources.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "Металл",
		kind = "resource",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 1,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0xb8c4d0,
		-- Цена единицы при продаже через космопорт.
		price = 10,
	},
	look = goods.look("metal", 0xb8c4d0),
}
