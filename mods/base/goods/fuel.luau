--!strict
-- Груз: топливо.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "resource",
	order = 3,
	color = 0xffc93c,
	price = 12,
}

kind.look = goods.look("fuel", kind.data.color)

return kind
