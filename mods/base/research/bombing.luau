--!strict
-- Тема исследований: бомбардировка. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 39,
		-- Темы, без которых эту не начать.
		after = { "aviation", "parts" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 3, fuel = 4, parts = 1 },
	},
}
