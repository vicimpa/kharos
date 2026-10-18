--!strict
-- Тема исследований: дороги. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.roads",
		info = "researchInfo.roads",
		-- Место в списке тем (TOPICS).
		order = 12,
		-- Темы, без которых эту не начать.
		after = { "science" },
	},
}
