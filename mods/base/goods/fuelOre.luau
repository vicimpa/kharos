--!strict
-- Груз: нефть.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "ore",
	order = 13,
	color = 0x8a7a2a,
	resource = "fuel",
}

kind.look = goods.look("ore", kind.data.color, require("./fuel").data.color)

return kind
