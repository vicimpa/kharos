--!strict
-- Тема исследований: ракеты. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Ярус 4: ракеты и огонь пехоте.
		title = "research.rockets",
		info = "researchInfo.rockets",
		-- Место в списке тем (TOPICS).
		order = 26,
		-- Темы, без которых эту не начать.
		after = { "infantry", "fuelOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { fuel = 6 },
	},
}
