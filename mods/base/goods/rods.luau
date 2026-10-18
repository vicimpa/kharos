--!strict
-- Груз: стержни.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "product",
	order = 10,
	color = 0x7ef0b0,
	-- Топливные стержни — реактору и боеголовке (§9 п. 4 design.md): второй слой, как и сам уран.
	recipe = { uranium = 2, metal = 1 },
	yield = 1,
}

kind.look = goods.look("rods", kind.data.color)

return kind
