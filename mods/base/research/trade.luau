--!strict
-- Тема исследований: торговля. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.trade",
		info = "researchInfo.trade",
		-- Место в списке тем (TOPICS).
		order = 9,
		-- Тема-открытие: открывается сама, когда это случилось с игроком.
		trigger = "refined",
	},
}
