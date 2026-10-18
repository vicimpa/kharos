--!strict
-- Тема исследований: переработка урана.

return {
	data = {
		-- Ярус 3: уран, компоненты, машинный завод, аэродром и ремонт, второй уровень зданий.
		order = 28,
		after = { "khariteOre", "uraniumFound" },
		uses = { uraniumOre = 6 },
	},
}
