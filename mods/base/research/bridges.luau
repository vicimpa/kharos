--!strict
-- Тема исследований: мосты. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 22,
		-- Темы, без которых эту не начать.
		after = { "roads", "metalOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 8 },
	},
}
