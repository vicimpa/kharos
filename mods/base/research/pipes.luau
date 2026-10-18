--!strict
-- Тема исследований: трубы. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Ярус 2: трубы, редкие руды, первые цеха, оборона.
		title = "research.pipes",
		info = "researchInfo.pipes",
		-- Место в списке тем (TOPICS).
		order = 16,
		-- Темы, без которых эту не начать.
		after = { "metalOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 4 },
	},
}
