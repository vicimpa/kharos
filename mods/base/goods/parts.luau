--!strict
-- Груз: компоненты. Данные — packages/base/data/products.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.parts",
		kind = "product",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 9,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x4fd6a2,
		-- Что уходит на одну сборку и сколько штук она даёт.
		recipe = { silicon = 2, kharite = 1 },
		yield = 1,
	},
	look = goods.look("parts", 0x4fd6a2),
}
