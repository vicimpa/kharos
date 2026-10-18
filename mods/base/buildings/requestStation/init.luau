--!strict
-- Станция запроса: держит заказанный игроком груз там, где он нужен, — у дальней стройки, у турелей, у армии.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Станция запроса",
	about = "Станция запроса: держит заказанный игроком груз там, где он нужен, — у дальней стройки, у турелей, у армии.",
	width = 2,
	height = 2,
	cost = 250,
	materials = { blocks = 4 },
	inventory = 100,
	requester = true,
	requires = { "blockPlant" },
	menu = 24,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
