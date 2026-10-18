--!strict
-- Груз: металлическая руда. Данные — packages/base/data/ores.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.metalOre",
		kind = "ore",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 11,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x8d7a5f,
		-- Что выходит на переработке.
		resource = "metal",
	},
	look = goods.look("ore", 0x8d7a5f, 0xb8c4d0),
}
