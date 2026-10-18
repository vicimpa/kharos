--!strict
-- Тема исследований: машины. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "Машины",
		info = "Машинный завод, багги и зенитка",
		-- Место в списке тем (TOPICS).
		order = 30,
		-- Темы, без которых эту не начать.
		after = { "blocks" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metal = 6, blocks = 3 },
	},
}
