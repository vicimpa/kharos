--!strict
-- Машина снабжения: хвост армии. Медленная и крупная, с пулемётчиком против разведки; раздаёт патроны своим вокруг, а
-- сама берёт их у грузовиков в поле, из хранилищ сети и быстрее всего — на станции поставки. Отсеки под топливо и
-- аккумуляторы добавятся в accepts, когда их начнут тратить. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, HAZARD = units.INK, units.STEEL, units.HAZARD

-- Машина снабжения: длинное шестиколёсное шасси, кабина спереди, за ней — кузов с ящиками патронов под тентом и мачта
-- излучателя раздачи. Пулемётчик над кабиной — турель gunner.
local function draw(p, team, phase)
	for _, side in { -7, 7 } do
		for _, wheel in { -8, -2.5, 6 } do units.tire(p, wheel, side, 2, 3.4, phase) end
	end
	p.bar(-12, 11, 0, 11, INK)
	p.bar(-11, 10, 0, 9, STEEL[1])
	p.bar(-11, 10, -3.8, 1.4, STEEL[2])
	-- Кузов: тент в цвет стороны и ящики под ним рядами.
	p.bar(-11, 2, 0, 10, INK)
	p.bar(-10.5, 1.5, 0, 9, team[0])
	for _, along in { -8.5, -4.5, -0.5 } do
		for _, across in { -2.4, 2.4 } do
			p.bar(along - 1.4, along + 1.4, across, 3.6, INK)
			p.bar(along - 1, along + 1, across, 2.8, 0x5b6b2e)
			p.bar(along - 1, along + 1, across - 0.9, 0.8, 0x8a9c4a)
		end
	end
	p.beam(-11, -4.5, 4.5, 1, HAZARD[1])
	-- Кабина.
	p.bar(3, 10, 0, 10, INK)
	p.bar(3.5, 9.5, 0, 9, HAZARD[1])
	p.bar(3.5, 9.5, -3.5, 1.2, HAZARD[2])
	p.bar(8, 9.5, 0, 7, team[2])
	-- Мачта излучателя раздачи на заднем борту.
	p.dot(-11.5, 3.5, 2, INK)
	p.dot(-11.5, 3.5, 1.3, 0x5ff2d0)
	p.dot(-11.9, 3.1, 0.5, 0xd8fff6)
end

local kind = {}

kind.data = {
	speed = 2,
	turn = 2.2,
	radius = 0.75,
	cost = 450,
	buildTime = 12,
	kind = "vehicle",
	hp = 400,
	materials = { metal = 12, blocks = 4 },
	sight = 7,
	ammo = 30,
	inventory = 150,
	accepts = { "ammo" },
	supplies = { radius = 6, rate = 10 },
	requires = { "supplyDepot" },
	mounts = { { turret = "gunner", along = 0.3, across = 0 } },
	supply = 2,
	motor = "diesel",
	pitch = 0.85,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -7, 7 }, width = 3.4 },
	lights = {
		lamps = { { 10, -3.5, 2.5 }, { 10, 3.5, 2.5 } },
		beam = { along = 13, length = 60, near = 5, spread = 0.3, level = 1 },
	},
})

return kind
