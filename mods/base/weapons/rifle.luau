--!strict
-- Пули: часто и слабо, хороши против пехоты, по броне и стенам почти бесполезны.
-- Данные — packages/base/data/weapons.json.

return {
	data = {
		about = "Пули: часто и слабо, хороши против пехоты, по броне и стенам почти бесполезны.",
		shot = "bullet",
		range = 4.5,
		damage = 5,
		reload = 0.4,
		speed = 24,
		air = true,
		vs = { vehicle = 0.5, heavy = 0.25, building = 0.2 },
	},
}
