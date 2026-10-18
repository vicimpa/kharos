--!strict
-- Груз: компоненты.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "product",
	order = 9,
	color = 0x4fd6a2,
	recipe = { silicon = 2, kharite = 1 },
	yield = 1,
}

kind.look = goods.look("parts", kind.data.color)

return kind
