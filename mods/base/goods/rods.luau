--!strict
-- Груз: стержни. Данные — packages/base/data/products.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.rods",
		kind = "product",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 10,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x7ef0b0,
		-- Топливные стержни — реактору и боеголовке (§9 п. 4 design.md): второй слой, как и сам уран.
		-- Что уходит на одну сборку и сколько штук она даёт.
		recipe = { uranium = 2, metal = 1 },
		yield = 1,
	},
	look = goods.look("rods", 0x7ef0b0),
}
