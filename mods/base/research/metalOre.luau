--!strict
-- Тема исследований: плавка металла. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Ярус 1: переработка трёх обычных руд — каждая открывается, когда найдено её месторождение, и изучается на руде из шахты.
		title = "research.metalOre",
		info = "researchInfo.metalOre",
		-- Место в списке тем (TOPICS).
		order = 13,
		-- Темы, без которых эту не начать.
		after = { "science", "metalFound" },
		-- Что тема тратит за всё исследование на первом ярусе.
		uses = { metalOre = 10 },
	},
}
