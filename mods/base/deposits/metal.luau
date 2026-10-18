--!strict
-- Месторождение: металл. Данные: запас от min до max, сколько в секунду добывает шахта и доли вида среди месторождений
-- каждого биома.

local deposits = require("lib/deposits")

return {
	data = {
		title = "goods.metal",
		min = 1200,
		max = 2500,
		-- Цвет ресурса: значок, груз на луче, точка на мини-карте.
		color = 0xb8c4d0,
		rate = 1,
		biomes = { erg = 0.3, saltFlats = 0.32, redWastes = 0.4, marsh = 0.32 },
	},
	entity = { Position = {}, Deposit = {}, Memorable = { width = deposits.SIZE, height = deposits.SIZE } },
	look = deposits.look("metal"),
}
