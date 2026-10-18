--!strict
-- Тема исследований: обогащение харита. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 17,
		-- Темы, без которых эту не начать.
		after = { "siliconOre", "khariteFound" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { khariteOre = 6 },
	},
}
