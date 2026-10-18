--!strict
-- Месторождение: литий. Данные — из packages/base/data/deposits.json: запас от min до max, сколько в секунду
-- добывает шахта и доли вида среди месторождений каждого биома.

local deposits = require("lib/deposits")

return {
	data = {
		title = "Литий",
		min = 400,
		max = 800,
		-- Цвет ресурса: значок, груз на луче, точка на мини-карте (resourceColors.ts).
		color = 0xf59ac0,
		rate = 0.5,
		biomes = { erg = 0.02, saltFlats = 0.14, redWastes = 0.02, marsh = 0.02 },
	},
	entity = { Position = {}, Deposit = {}, Memorable = { width = deposits.SIZE, height = deposits.SIZE } },
	look = deposits.look("lithium"),
}
