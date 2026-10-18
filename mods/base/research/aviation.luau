--!strict
-- Тема исследований: авиация. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.aviation",
		info = "researchInfo.aviation",
		-- Место в списке тем (TOPICS).
		order = 31,
		-- Темы, без которых эту не начать.
		after = { "blocks", "fuelOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 4, blocks = 2, fuel = 4 },
	},
}
