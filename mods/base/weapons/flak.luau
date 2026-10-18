--!strict
-- Зенитка: частые разрывы по воздуху, далеко и сильно, по земле не стреляет.
-- Данные — packages/base/data/weapons.json.

return {
	data = {
		shot = "bullet",
		range = 8,
		damage = 22,
		reload = 0.5,
		speed = 30,
		splash = 0.6,
		air = true,
		onlyAir = true,
	},
}
