--!strict
-- Тема исследований: топливные стержни. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 41,
		-- Темы, без которых эту не начать.
		after = { "uraniumOre", "blocks" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { uranium = 4, metal = 2 },
	},
}
