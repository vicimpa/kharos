--!strict
-- Тема исследований: глубокая модернизация. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 40,
		-- Темы, без которых эту не начать.
		after = { "levels2", "parts" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { blocks = 4, parts = 1 },
	},
}
