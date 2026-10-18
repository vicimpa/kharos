--!strict
-- Груз: харит.

local goods = require("lib/goods")

local kind = {}

kind.data = {
	kind = "resource",
	order = 4,
	color = 0xc06bff,
	-- Харит редок и дорог: месторождения его малы, а добыча медленная.
	price = 60,
}

kind.look = goods.look("kharite", kind.data.color)

return kind
