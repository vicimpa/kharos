--!strict
-- Пехота. Огнемётчик: штурмовик ближнего боя — выжигает пехоту в окопах и здания, к броне ему не подойти. Мотор и тон —
-- sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON, HAZARD = units.INK, units.STEEL, units.IRON, units.HAZARD

-- Огнемётчик: баллоны за спиной, брандспойт в руках и горящий запальник на конце.
local function draw(p, team, phase)
	units.legs(p, phase)
	-- Баллоны за спиной.
	for _, across in { -1.6, 1.6 } do
		p.dot(-2.2, across, 1.6, INK)
		p.dot(-2.2, across, 1, HAZARD[1])
	end
	p.beam(0, -3.5, 3.5, 5, INK)
	p.beam(0, -2.5, 2.5, 3, team[0])
	-- Брандспойт и запальник.
	p.bar(-1, 6, 1.8, 2.4, INK)
	p.bar(0, 5, 1.8, 1, IRON[3])
	p.dot(6.2, 1.8, 1.1, 0xff8a2a)
	p.dot(0.5, -0.3, 2, INK)
	p.dot(0.5, -0.3, 1.2, STEEL[4])
end

local kind = {}

kind.data = {
	speed = 3.4,
	turn = 10,
	radius = 0.3,
	cost = 140,
	buildTime = 5,
	kind = "infantry",
	hp = 90,
	weapon = "flame",
	research = "flamer",
	ammo = 20,
	supply = 1,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "legs",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -1.5, 1.5 }, width = 1.4 },
	lights = {
		lamps = { { 6, 1.5, 1.5 } },
		beam = { along = 7, length = 30, near = 1.5, spread = 0.25, level = 0.8 },
	},
})

return kind
