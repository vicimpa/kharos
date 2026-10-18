--!strict
-- Зенитка: быстрая машина со спаренной автопушкой, бьёт только по воздуху — далеко и сильно. Мотор и тон —
-- sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON = units.INK, units.STEEL, units.IRON

-- Зенитка: лёгкое колёсное шасси с поворотной платформой и спаренной автопушкой, задранной вверх.
local function draw(p, team, phase)
	units.wheels(p, 4.5, 4.5, phase)
	p.bar(-7, 6, 0, 8, INK)
	p.bar(-6, 5, 0, 6, STEEL[1])
	p.bar(-6, 5, -2.5, 1, STEEL[3])
	p.bar(-6, -4, 0, 6, team[0])
	-- Платформа и два ствола.
	p.dot(-0.5, 0, 3.6, INK)
	p.dot(-0.5, 0, 2.8, STEEL[2])
	for _, across in { -1.4, 1.4 } do
		p.bar(0, 9, across, 1.8, INK)
		p.bar(1, 8.5, across, 0.8, IRON[4])
	end
	p.dot(-0.5, 0, 1.4, team[1])
end

local kind = {}

kind.data = {
	speed = 5,
	turn = 4.5,
	radius = 0.5,
	cost = 350,
	buildTime = 8,
	kind = "vehicle",
	hp = 170,
	weapon = "flak",
	materials = { metal = 8 },
	sight = 10,
	ammo = 40,
	supply = 2,
	motor = "petrol",
}

kind.entity = units.entity
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -4.5, 4.5 }, width = 3 },
	lights = {
		lamps = { { 7, -2.5, 2 }, { 7, 2.5, 2 } },
		beam = { along = 10, length = 56, near = 4, spread = 0.3, level = 1 },
	},
})

return kind
