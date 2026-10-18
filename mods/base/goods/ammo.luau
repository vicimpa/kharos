--!strict
-- Груз: боеприпасы. Данные — packages/base/data/products.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "Боеприпасы",
		kind = "product",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 8,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0xe0803a,
		-- Что уходит на одну сборку и сколько штук она даёт.
		recipe = { metal = 1 },
		yield = 10,
	},
	look = goods.look("ammo", 0xe0803a),
}
