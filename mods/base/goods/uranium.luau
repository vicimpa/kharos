--!strict
-- Груз: уран.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "resource",
	order = 6,
	color = 0xb4e84a,
	-- Уран закупить нельзя: иначе реактор и ядерный заряд покупались бы за кредиты (§9 п. 4 design.md).
	price = 40,
	-- С орбиты не закупается: только своя добыча.
	mined = true,
}

kind.look = goods.look("uranium", kind.data.color)

return kind
