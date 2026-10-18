--!strict
-- Груз: урановая руда. Данные — packages/base/data/ores.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.uraniumOre",
		kind = "ore",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 16,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x6a8a3a,
		-- Что выходит на переработке.
		resource = "uranium",
	},
	look = goods.look("ore", 0x6a8a3a, 0xb4e84a),
}
