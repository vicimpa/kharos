--!strict
-- Груз: харит. Данные — packages/base/data/resources.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "goods.kharite",
		kind = "resource",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 4,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0xc06bff,
		-- Харит редок и дорог: месторождения его малы, а добыча медленная.
		-- Цена единицы при продаже через космопорт.
		price = 60,
	},
	look = goods.look("kharite", 0xc06bff),
}
