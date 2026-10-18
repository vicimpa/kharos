--!strict
-- Тема исследований: харит найден. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.khariteFound",
		info = "researchInfo.khariteFound",
		-- Место в списке тем (TOPICS).
		order = 6,
		-- Тема-открытие: открывается сама, когда это случилось с игроком.
		trigger = "kharite",
	},
}
