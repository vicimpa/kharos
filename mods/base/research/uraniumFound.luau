--!strict
-- Тема исследований: уран найден. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.uraniumFound",
		info = "researchInfo.uraniumFound",
		-- Место в списке тем (TOPICS).
		order = 8,
		-- Тема-открытие: открывается сама, когда это случилось с игроком.
		trigger = "uranium",
	},
}
