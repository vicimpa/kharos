--!strict
-- Тема исследований: пехота. Данные — packages/base/data/research.json, название и описание — ru.json.

return {
	data = {
		-- Ярус 3: пехота — когда есть патроны: без них её магазины не пополнить; колодцы — после труб, накопитель — на литии.
		title = "research.infantry",
		info = "researchInfo.infantry",
		-- Место в списке тем (TOPICS).
		order = 23,
		-- Темы, без которых эту не начать.
		after = { "ammo" },
	},
}
