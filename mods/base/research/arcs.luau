--!strict
-- Тема исследований: разряд. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Ярус 5: разряд, щит, осада, реактор.
		title = "research.arcs",
		info = "researchInfo.arcs",
		-- Место в списке тем (TOPICS).
		order = 42,
		-- Темы, без которых эту не начать.
		after = { "lasers", "parts" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { silicon = 2, parts = 2 },
	},
}
