--!strict
-- Тема исследований: колодцы. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.wells",
		info = "researchInfo.wells",
		-- Место в списке тем (TOPICS).
		order = 24,
		-- Темы, без которых эту не начать.
		after = { "pipes" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 6 },
	},
}
