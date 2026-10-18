--!strict
-- Тема исследований: переработка урана. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Ярус 3: уран, компоненты, машинный завод, аэродром и ремонт, второй уровень зданий.
		title = "research.uraniumOre",
		info = "researchInfo.uraniumOre",
		-- Место в списке тем (TOPICS).
		order = 28,
		-- Темы, без которых эту не начать.
		after = { "khariteOre", "uraniumFound" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { uraniumOre = 6 },
	},
}
