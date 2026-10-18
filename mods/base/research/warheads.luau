--!strict
-- Тема исследований: боеголовки. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Ярус 6: ракетная шахта.
		title = "research.warheads",
		info = "researchInfo.warheads",
		-- Место в списке тем (TOPICS).
		order = 46,
		-- Темы, без которых эту не начать.
		after = { "atom" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { rods = 3, parts = 2 },
	},
}
