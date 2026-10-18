--!strict
-- Груз: нефть. Данные — packages/base/data/ores.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.fuelOre",
		kind = "ore",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 13,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x8a7a2a,
		-- Что выходит на переработке.
		resource = "fuel",
	},
	look = goods.look("ore", 0x8a7a2a, 0xffc93c),
}
