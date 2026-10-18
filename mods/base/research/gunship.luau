--!strict
-- Тема исследований: штурмовая авиация. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.gunship",
		info = "researchInfo.gunship",
		-- Место в списке тем (TOPICS).
		order = 38,
		-- Темы, без которых эту не начать.
		after = { "aviation" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 4, silicon = 2, fuel = 3 },
	},
}
