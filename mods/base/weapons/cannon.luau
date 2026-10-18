--!strict
-- Ядро летит быстро и прямо в точку, где цель была при выстреле: от него можно уехать. Бьёт по площади.

return {
	data = {
		shot = "shell",
		range = 7,
		damage = 60,
		reload = 2.5,
		speed = 18,
		splash = 1.5,
		air = false,
		vs = { infantry = 0.6 },
		ammo = 8,
	},
}
