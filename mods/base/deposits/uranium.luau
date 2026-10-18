--!strict
-- Месторождение: уран. Данные: запас от min до max, сколько в секунду добывает шахта и доли вида среди месторождений
-- каждого биома.

local deposits = require("lib/deposits")

return {
	data = {
		title = "goods.uranium",
		min = 300,
		max = 600,
		-- Цвет ресурса: значок, груз на луче, точка на мини-карте.
		color = 0xb4e84a,
		rate = 0.3,
		biomes = { erg = 0.02, saltFlats = 0.02, redWastes = 0.18, marsh = 0.02 },
	},
	entity = { Position = {}, Deposit = {}, Memorable = { width = deposits.SIZE, height = deposits.SIZE } },
	look = deposits.look("uranium"),
}
