--!strict
-- Груз: металл.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "resource",
	order = 1,
	color = 0xb8c4d0,
	price = 10,
}

kind.look = goods.look("metal", kind.data.color)

return kind
