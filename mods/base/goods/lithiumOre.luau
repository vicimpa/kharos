--!strict
-- Груз: литиевая руда. Данные — packages/base/data/ores.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "Литиевая руда",
		kind = "ore",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 15,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0x9a6a7e,
		-- Что выходит на переработке.
		resource = "lithium",
	},
	look = goods.look("ore", 0x9a6a7e, 0xf59ac0),
}
