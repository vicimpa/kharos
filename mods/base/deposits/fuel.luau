--!strict
-- Месторождение: топливо. Данные — из packages/base/data/deposits.json: запас от min до max, сколько в секунду
-- добывает шахта и доли вида среди месторождений каждого биома.

local deposits = require("lib/deposits")

return {
	data = {
		title = "goods.fuel",
		min = 800,
		max = 1600,
		-- Цвет ресурса: значок, груз на луче, точка на мини-карте (resourceColors.ts).
		color = 0xffc93c,
		rate = 0.8,
		biomes = { erg = 0.14, saltFlats = 0.14, redWastes = 0.14, marsh = 0.38 },
	},
	entity = { Position = {}, Deposit = {}, Memorable = { width = deposits.SIZE, height = deposits.SIZE } },
	look = deposits.look("fuel"),
}
