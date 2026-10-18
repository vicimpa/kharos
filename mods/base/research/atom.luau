--!strict
-- Тема исследований: атом. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 45,
		-- Темы, без которых эту не начать.
		after = { "rods", "parts" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { rods = 2, parts = 1 },
	},
}
