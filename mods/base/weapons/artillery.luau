--!strict
-- Гаубица: навесом через стены и дальше турелей, тяжёлым снарядом по площади, вдвое сильнее по зданиям. Вблизи —
-- мёртвая зона: до подошедшего врага ей не достать. Осадное оружие.
-- Данные — packages/base/data/weapons.json.

return {
	data = {
		shot = "shell",
		range = 11,
		minRange = 3,
		damage = 70,
		reload = 4,
		speed = 8,
		splash = 1.8,
		lob = true,
		air = false,
		vs = { building = 2, infantry = 0.6, vehicle = 0.4, heavy = 0.5 },
	},
}
