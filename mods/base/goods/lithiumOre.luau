--!strict
-- Груз: литиевая руда.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "ore",
	order = 15,
	color = 0x9a6a7e,
	resource = "lithium",
}

kind.look = goods.look("ore", kind.data.color, require("./lithium").data.color)

return kind
