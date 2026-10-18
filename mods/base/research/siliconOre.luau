--!strict
-- Тема исследований: обработка кремния. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.siliconOre",
		info = "researchInfo.siliconOre",
		-- Место в списке тем (TOPICS).
		order = 14,
		-- Темы, без которых эту не начать.
		after = { "science", "siliconFound" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { siliconOre = 10 },
	},
}
