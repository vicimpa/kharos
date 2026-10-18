--!strict
-- Генератор щита гасит урон по своим под куполом от стрелков снаружи: против артиллерии и бомбардировщиков, а не
-- против штурма вплотную. Энергию берёт всегда; строится из компонентов.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
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
