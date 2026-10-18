--!strict
-- Ракета бьёт дальше прочей техники и достаёт и технику, и летающих: этим оружием встречают лёгкую броню и авиацию.

return {
	data = {
		shot = "rocket",
		range = 6.5,
		damage = 36,
		reload = 2,
		speed = 8,
		splash = 0.7,
		air = true,
		vs = { infantry = 0.3, heavy = 0.8, air = 1.5 },
		ammo = 6,
	},
}
