--!strict
-- Тема исследований: радиолокация. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.radar",
		info = "researchInfo.radar",
		-- Место в списке тем (TOPICS).
		order = 11,
		-- Темы, без которых эту не начать.
		after = { "science" },
	},
}
