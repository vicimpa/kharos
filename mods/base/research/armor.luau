--!strict
-- Тема исследований: тяжёлая броня. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 37,
		-- Темы, без которых эту не начать.
		after = { "vehicles", "parts" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 6, parts = 1 },
	},
}
