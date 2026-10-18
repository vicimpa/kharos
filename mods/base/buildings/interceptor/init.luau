--!strict
-- Перехватчик: защита от ядерного удара. Без урана — его с орбиты не купить, и защита из урана оставила бы
-- беззащитным каждого, кто сел не в рыжих пустошах. Дешевле удара (2100 против 5000 с лишним), но строится заранее.
-- Держит четыре ракеты: залп из нескольких шахт один перехватчик тоже встречает. Перехватчик своей темы не просит:
-- защита не должна ждать дерева. Радар нужен — им он видит ракету.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 1500,
	power = -4,
	materials = { parts = 8 },
	intercept = { radius = 80, cost = 600, materials = { parts = 4, fuel = 10 }, seconds = 60, speed = 30, capacity = 4 },
	requires = { "radar" },
	menu = 44,
	-- Раздел сетки строителя.
	section = "defense",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
