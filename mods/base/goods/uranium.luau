--!strict
-- Груз: уран. Данные — packages/base/data/resources.json, цвет —
-- resourceColors.ts, значок — goodIcons.ts.

local goods = require("lib/goods")

return {
	data = {
		title = "Уран",
		kind = "resource",
		-- Место в списке грузов (GOODS): ресурсы, изделия, руда.
		order = 6,
		-- Цвет груза: значок, груз на луче, месторождение на карте.
		color = 0xb4e84a,
		-- Уран закупить нельзя: иначе реактор и ядерный заряд покупались бы за кредиты (§9 п. 4 design.md).
		-- Цена единицы при продаже через космопорт.
		price = 40,
		-- С орбиты не закупается: только своя добыча.
		mined = true,
	},
	look = goods.look("uranium", 0xb4e84a),
}
