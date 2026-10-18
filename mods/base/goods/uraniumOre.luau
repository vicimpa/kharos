--!strict
-- Груз: урановая руда.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "ore",
	order = 16,
	color = 0x6a8a3a,
	resource = "uranium",
}

kind.look = goods.look("ore", kind.data.color, require("./uranium").data.color)

return kind
