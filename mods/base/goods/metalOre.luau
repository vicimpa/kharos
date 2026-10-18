--!strict
-- Груз: металлическая руда.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "ore",
	order = 11,
	color = 0x8d7a5f,
	resource = "metal",
}

kind.look = goods.look("ore", kind.data.color, require("./metal").data.color)

return kind
