--!strict
-- Груз: стройблоки. Данные — packages/base/data/products.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "Стройблоки",
		kind = "product",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 7,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0xd8b98a,
		-- Что уходит на одну сборку и сколько штук она даёт.
		recipe = { metal = 2, silicon = 1 },
		yield = 1,
	},
	look = goods.look("blocks", 0xd8b98a),
}
