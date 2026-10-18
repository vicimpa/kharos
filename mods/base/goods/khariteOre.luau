--!strict
-- Груз: харитовая руда.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "ore",
	order = 14,
	color = 0x7a4a9a,
	resource = "kharite",
}

kind.look = goods.look("ore", kind.data.color, require("./kharite").data.color)

return kind
