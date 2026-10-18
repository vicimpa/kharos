--!strict
-- Тема исследований: щиты. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 43,
		-- Темы, без которых эту не начать.
		after = { "lasers", "parts" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { parts = 2 },
	},
}
