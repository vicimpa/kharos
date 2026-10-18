--!strict
-- Тема исследований: ворота. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.gates",
		info = "researchInfo.gates",
		-- Место в списке тем (TOPICS).
		order = 21,
		-- Темы, без которых эту не начать.
		after = { "walls", "metalOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 6 },
	},
}
