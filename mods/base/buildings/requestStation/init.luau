--!strict
-- Станция запроса: держит заказанный игроком груз там, где он нужен, — у дальней стройки, у турелей, у армии.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 250,
	materials = { blocks = 4 },
	inventory = 100,
	requester = true,
	requires = { "blockPlant" },
	menu = 24,
	-- Раздел сетки строителя.
	section = "storage",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
