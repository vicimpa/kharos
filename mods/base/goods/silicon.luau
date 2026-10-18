--!strict
-- Груз: кремний.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "resource",
	order = 2,
	color = 0x7f9cff,
	price = 10,
}

kind.look = goods.look("silicon", kind.data.color)

return kind
