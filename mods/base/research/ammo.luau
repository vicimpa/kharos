--!strict
-- Тема исследований: боеприпасы. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.ammo",
		info = "researchInfo.ammo",
		-- Место в списке тем (TOPICS).
		order = 20,
		-- Темы, без которых эту не начать.
		after = { "metalOre" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 8 },
	},
}
