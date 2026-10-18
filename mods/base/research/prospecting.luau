--!strict
-- Тема исследований: разведка недр. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		title = "research.prospecting",
		info = "researchInfo.prospecting",
		-- Место в списке тем (TOPICS).
		order = 2,
		-- Тема-открытие: открывается сама, когда это случилось с игроком.
		trigger = "deposit",
	},
}
