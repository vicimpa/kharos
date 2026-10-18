--!strict
-- Тема исследований: перегонка нефти. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 15,
		-- Темы, без которых эту не начать.
		after = { "science", "fuelFound" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { fuelOre = 10 },
	},
}
