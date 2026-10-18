--!strict
-- Месторождение: харит. Данные: запас от min до max, сколько в секунду добывает шахта и доли вида среди месторождений
-- каждого биома.

local deposits = require("lib/deposits")

return {
	data = {
		title = "goods.kharite",
		min = 200,
		max = 400,
		-- Цвет ресурса: значок, груз на луче, точка на мини-карте.
		color = 0xc06bff,
		rate = 0.3,
		biomes = { erg = 0.34, saltFlats = 0.08, redWastes = 0.08, marsh = 0.08 },
	},
	entity = { Position = {}, Deposit = {}, Memorable = { width = deposits.SIZE, height = deposits.SIZE } },
	look = deposits.look("kharite"),
}
