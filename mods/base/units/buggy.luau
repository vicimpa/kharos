--!strict
-- Машинки: быстрые и хрупкие. Багги: за водителем сидит пассажир с миниганом и стреляет во все стороны. Она же
-- разведчик: видит дальше всех на земле. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON = units.INK, units.STEEL, units.IRON

-- Багги: узкая быстрая машина с дугой безопасности. Пассажира с миниганом рисует турель gunner поверх.
local function draw(p, team, phase)
	units.wheels(p, 4.5, 4, phase)
	p.bar(-6, 7, 0, 7, INK)
	p.bar(-5, 6, 0, 5, IRON[2])
	p.bar(-5, 6, -2, 1, IRON[3])
	p.bar(-5, -3, 0, 5, team[0])
	-- Водитель за лобовым стеклом и дуга над ним.
	p.bar(4.5, 6, 0, 4, team[2])
	p.dot(2.5, 0, 1.3, INK)
	p.dot(2.5, 0, 0.8, STEEL[4])
	p.beam(1, -3.5, 3.5, 1, INK)
end

local kind = {}

kind.data = {
	speed = 6,
	turn = 5,
	radius = 0.45,
	cost = 250,
	buildTime = 7,
	kind = "vehicle",
	hp = 150,
	materials = { metal = 6 },
	sight = 11,
	ammo = 30,
	mounts = { { turret = "gunner", along = -0.16, across = 0 } },
	supply = 2,
	motor = "petrol",
	pitch = 1.18,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -4.5, 4.5 }, width = 3 },
	lights = {
		lamps = { { 7, -2, 2 }, { 7, 2, 2 } },
		beam = { along = 10, length = 60, near = 4, spread = 0.28, level = 1 },
	},
})

return kind
