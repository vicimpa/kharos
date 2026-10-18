--!strict
-- Лазер попадает сразу и всегда и лучше всех пробивает тяжёлую броню: это оружие против танков.
-- Данные — packages/base/data/weapons.json.

return {
	data = {
		shot = "laser",
		range = 7.5,
		damage = 28,
		reload = 1.1,
		air = true,
		vs = { heavy = 1.6, building = 0.5 },
	},
}
