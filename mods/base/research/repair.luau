--!strict
-- Тема исследований: ремонт. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 33,
		-- Темы, без которых эту не начать.
		after = { "blocks" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { blocks = 4 },
	},
}
