--!strict
-- Тема исследований: компоненты. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.parts",
		info = "researchInfo.parts",
		-- Место в списке тем (TOPICS).
		order = 29,
		-- Темы, без которых эту не начать.
		after = { "khariteOre", "blocks" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { silicon = 4, kharite = 2 },
	},
}
