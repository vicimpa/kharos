--!strict
-- Летающие: им нужно топливо. Летающий грузовик: везёт меньше обычного, зато вдвое быстрее и напрямик — над болотами и
-- горами. Его сбивает ПВО. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, IRON, HAZARD = units.INK, units.IRON, units.HAZARD

-- Летающий грузовик: четыре винта на длинных балках, под ними — грузовой контейнер в жёлто-чёрных полосах.
local function draw(p, team)
	for _, pair in { { 6, 6 }, { 6, -6 }, { -6, 6 }, { -6, -6 } } do
		local along, across = pair[1], pair[2]
		p.line(0, 0, along, across, 2.4, INK)
		p.line(0, 0, along, across, 1, IRON[2])
		p.dot(along, across, 3.2, INK)
		p.dot(along, across, 2.2, IRON[3])
		p.dot(along, across, 0.8, IRON[0])
	end
	-- Контейнер.
	p.bar(-4.5, 4.5, 0, 8, INK)
	p.bar(-3.5, 3.5, 0, 6, HAZARD[1])
	for _, along in { -2, 1 } do p.beam(along, -3, 3, 1, HAZARD[0]) end
	-- Кабина спереди.
	p.bar(4, 7, 0, 4, INK)
	p.bar(4.5, 6.5, 0, 2.4, team[0])
	p.dot(6, -0.6, 0.7, team[2])
end

local kind = {}

kind.data = {
	speed = 7,
	turn = 5,
	radius = 0.45,
	cost = 300,
	buildTime = 10,
	kind = "air",
	hp = 100,
	sight = 8,
	inventory = 10,
	hauls = true,
	beam = { radius = 2, rate = 10, give = true, take = true },
	materials = { fuel = 4 },
	supply = 2,
	motor = "rotor",
}

kind.entity = units.entity
kind.look = units.look({
	gait = "air",
	draw = draw,
	mounts = kind.data.mounts,
	lights = {
		lamps = { { 7, 0, 1.5 } },
		beam = { along = 8, length = 44, near = 2, spread = 0.3, level = 0.8 },
	},
})

return kind
