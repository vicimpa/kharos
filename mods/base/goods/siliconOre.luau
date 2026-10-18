--!strict
-- Груз: кремниевая руда. Данные — packages/base/data/ores.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.siliconOre",
		kind = "ore",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 12,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x5a6a8a,
		-- Что выходит на переработке.
		resource = "silicon",
	},
	look = goods.look("ore", 0x5a6a8a, 0x7f9cff),
}
