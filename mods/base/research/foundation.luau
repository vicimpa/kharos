--!strict
-- Тема исследований: фундамент. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.foundation",
		info = "researchInfo.foundation",
		-- Место в списке тем (TOPICS).
		order = 34,
		-- Темы, без которых эту не начать.
		after = { "blocks" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { blocks = 4 },
	},
}
