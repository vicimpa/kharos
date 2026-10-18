--!strict
-- Груз: кремний. Данные — packages/base/data/resources.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.silicon",
		kind = "resource",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 2,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x7f9cff,
		-- Цена единицы при продаже через космопорт.
		price = 10,
	},
	look = goods.look("silicon", 0x7f9cff),
}
