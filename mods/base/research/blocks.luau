--!strict
-- Тема исследований: стройблоки. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 19,
		-- Темы, без которых эту не начать.
		after = { "metalOre", "siliconOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 6, silicon = 3 },
	},
}
