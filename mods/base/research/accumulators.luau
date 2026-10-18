--!strict
-- Тема исследований: накопители. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 25,
		-- Темы, без которых эту не начать.
		after = { "lithiumOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { lithium = 6 },
	},
}
