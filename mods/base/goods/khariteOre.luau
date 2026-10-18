--!strict
-- Груз: харитовая руда. Данные — packages/base/data/ores.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.khariteOre",
		kind = "ore",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 14,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x7a4a9a,
		-- Что выходит на переработке.
		resource = "kharite",
	},
	look = goods.look("ore", 0x7a4a9a, 0xc06bff),
}
