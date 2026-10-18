--!strict
-- Генератор щита гасит урон по своим под куполом от стрелков снаружи: против артиллерии и бомбардировщиков, а не
-- против штурма вплотную. Энергию берёт всегда; строится из компонентов.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.shieldGenerator",
	about = "Генератор щита гасит урон по своим под куполом от стрелков снаружи: против артиллерии и бомбардировщиков, а не против штурма вплотную. Энергию берёт всегда; строится из компонентов.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.shieldGenerator",
	width = 2,
	height = 2,
	cost = 1200,
	power = -6,
	materials = { parts = 5 },
	shield = { radius = 7, capacity = 4000, regen = 100 },
	research = "shields",
	menu = 43,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
