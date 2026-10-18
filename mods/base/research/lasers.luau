--!strict
-- Тема исследований: лазеры. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Место в списке тем (TOPICS).
		order = 36,
		-- Темы, без которых эту не начать.
		after = { "vehicles" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { silicon = 4, metal = 2 },
	},
}
