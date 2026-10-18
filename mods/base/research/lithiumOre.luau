--!strict
-- Тема исследований: выпарка лития. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 18,
		-- Темы, без которых эту не начать.
		after = { "metalOre", "lithiumFound" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { lithiumOre = 6 },
	},
}
