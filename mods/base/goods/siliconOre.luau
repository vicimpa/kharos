--!strict
-- Груз: кремниевая руда.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "ore",
	order = 12,
	color = 0x5a6a8a,
	resource = "silicon",
}

kind.look = goods.look("ore", kind.data.color, require("./silicon").data.color)

return kind
