--!strict
-- Груз: стройблоки.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "product",
	order = 7,
	color = 0xd8b98a,
	recipe = { metal = 2, silicon = 1 },
	yield = 1,
}

kind.look = goods.look("blocks", kind.data.color)

return kind
