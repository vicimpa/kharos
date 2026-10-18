--!strict
-- Месторождение: кремний. Данные — из packages/base/data/deposits.json: запас от min до max, сколько в секунду
-- добывает шахта и доли вида среди месторождений каждого биома.

local deposits = require("lib/deposits")

return {
	data = {
		title = "goods.silicon",
		min = 1200,
		max = 2500,
		-- Цвет ресурса: значок, груз на луче, точка на мини-карте (resourceColors.ts).
		color = 0x7f9cff,
		rate = 1,
		biomes = { erg = 0.18, saltFlats = 0.3, redWastes = 0.18, marsh = 0.18 },
	},
	entity = { Position = {}, Deposit = {}, Memorable = { width = deposits.SIZE, height = deposits.SIZE } },
	look = deposits.look("silicon"),
}
