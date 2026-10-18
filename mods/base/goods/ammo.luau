--!strict
-- Груз: боеприпасы.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "product",
	order = 8,
	color = 0xe0803a,
	recipe = { metal = 1 },
	yield = 10,
}

kind.look = goods.look("ammo", kind.data.color)

return kind
