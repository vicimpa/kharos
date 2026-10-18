--!strict
-- Оружие machinegun.
-- Данные — packages/base/data/weapons.json.

return {
	data = {
		shot = "bullet",
		range = 5,
		damage = 6,
		reload = 0.18,
		speed = 26,
		air = true,
		vs = { vehicle = 0.5, heavy = 0.25, building = 0.2 },
		ammo = 0.5,
	},
}
