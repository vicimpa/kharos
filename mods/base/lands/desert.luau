--!strict
-- Пустыня: генератор местности с настройками по умолчанию. Зоны болот, песков и скал, биомы (эрг, солончаки, красные
-- пустоши, топи), горы с вершинами, ярусы плато и обрывы.

return {
	-- Мини-карта: цвета местности по биомам (эрг, солончаки, красные пустоши, топи) — [песок, скала, болото, горы],
	-- средние тона палитр terrain.frag.
	minimap = {
		{ { 194, 153, 69 }, { 99, 69, 15 }, { 54, 51, 26 }, { 140, 104, 40 } },
		{ { 209, 201, 179 }, { 94, 92, 84 }, { 77, 133, 133 }, { 130, 128, 120 } },
		{ { 179, 92, 41 }, { 84, 36, 20 }, { 69, 33, 18 }, { 128, 64, 36 } },
		{ { 133, 122, 56 }, { 69, 64, 33 }, { 26, 54, 33 }, { 100, 95, 52 } },
	},
	data = {
		seed = 1337,
		zoneScale = 56,
		zoneWarp = 30,
		swampLevel = 0.37,
		rockLevel = 0.59,
		biomeScale = 240,
		peakChance = 0.3,
		peakMinRadius = 1,
		peakMaxRadius = 2,
		doubleChance = 0.35,
		tripleChance = 0.15,
		saltSwampShift = -0.05,
		saltRockShift = 0.05,
		saltPeakFactor = 1,
		redSwampShift = -0.06,
		redRockShift = -0.07,
		redPeakFactor = 2.5,
		marshSwampShift = 0.09,
		marshRockShift = 0.04,
		marshPeakFactor = 0.5,
		tierStep = 0.065,
		cliffScale = 20,
		cliffShare = 0.35,
		depositChance = 0.95,
		depositRichness = 1,
	},
}
