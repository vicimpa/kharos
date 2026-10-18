--!strict
-- Огнемёт: струя бьёт в упор и перекидывается на соседа. Выжигает пехоту и здания, по броне слаб.
-- Данные — packages/base/data/weapons.json.

return {
	data = {
		shot = "flame",
		range = 3,
		damage = 14,
		reload = 0.4,
		chain = 1,
		air = false,
		vs = { infantry = 1.5, building = 1.2, vehicle = 0.3, heavy = 0.15 },
	},
}
