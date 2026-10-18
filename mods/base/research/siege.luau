--!strict
-- Тема исследований: осадное дело. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.siege",
		info = "researchInfo.siege",
		-- Место в списке тем (TOPICS).
		order = 44,
		-- Темы, без которых эту не начать.
		after = { "armor" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 4, blocks = 1, parts = 1 },
	},
}
