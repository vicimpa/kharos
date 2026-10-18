--!strict
-- Грузовик возит добытое из шахты в хранилище и заказанное по зонам (mechanics/hauling). Своим лучом он и забирает
-- груз, и сгружает его: зданиям лучи не нужны. Харвестер — шахта на колёсах: копает медленнее шахты, зато сам и где
-- угодно, и сам возит руду на переработку. Тяжелее грузовика: его ловят в поле, и он должен пережить первый налёт.
-- Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, IRON, HAZARD = units.INK, units.IRON, units.HAZARD

-- Грузовик: кабина спереди и открытый кузов с рудой.
local function draw(p, team, phase)
	for _, side in { -4.5, 4.5 } do
		for _, wheel in { -5, 0, 5 } do units.tire(p, wheel, side, 1.5, 3, phase) end
	end
	p.bar(-8, 8, 0, 9, INK)
	-- Кузов: борта и руда внутри.
	p.bar(-7, 2, 0, 7, IRON[2])
	p.bar(-6, 1, 0, 5, 0x6b2f1e)
	p.bar(-5, 0, -1, 2, 0xb5562e)
	p.dot(-2, 1, 1, 0xe58a4a)
	-- Кабина.
	p.bar(3, 7, 0, 7, HAZARD[1])
	p.bar(3, 7, -3, 1, HAZARD[2])
	p.bar(5, 6, 0, 5, team[2])
	-- Излучатель транспортного луча за кабиной.
	p.dot(2, 0, 1.8, INK)
	p.dot(2, 0, 1.2, 0x5ff2d0)
	p.dot(1.6, -0.4, 0.5, 0xd8fff6)
end

local kind = {}

kind.data = {
	speed = 3.5,
	turn = 4,
	radius = 0.45,
	cost = 150,
	buildTime = 8,
	kind = "vehicle",
	hp = 150,
	sight = 6,
	inventory = 25,
	hauls = true,
	beam = { radius = 2, rate = 10, give = true, take = true },
	supply = 1,
	motor = "diesel",
}

kind.entity = units.entity
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -4.5, 4.5 }, width = 3 },
	lights = {
		lamps = { { 8, -2.5, 2 }, { 8, 2.5, 2 } },
		beam = { along = 11, length = 56, near = 4.5, spread = 0.3, level = 1 },
	},
})

return kind
