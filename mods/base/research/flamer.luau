--!strict
-- Тема исследований: огнемёты. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.flamer",
		info = "researchInfo.flamer",
		-- Место в списке тем (TOPICS).
		order = 27,
		-- Темы, без которых эту не начать.
		after = { "infantry", "fuelOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { fuel = 8 },
	},
}
