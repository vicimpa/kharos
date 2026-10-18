--!strict
-- Разряд бьёт цель и перескакивает на соседей: против толпы.

return {
	data = {
		shot = "arc",
		range = 4.5,
		damage = 46,
		reload = 2,
		chain = 2,
		air = true,
		vs = { infantry = 1.5, building = 0.4, air = 0.25 },
	},
}
