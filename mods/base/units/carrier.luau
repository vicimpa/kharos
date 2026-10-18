--!strict
-- Носитель: колёсное шасси танка без своего оружия — на нём три ракетные турели и ремонтная. Ремонтной нужен компонент.
-- Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON = units.INK, units.STEEL, units.IRON

-- Носитель: колёсное шасси танка — по три колеса с борта и плоская палуба с четырьмя гнёздами под турели. Сами турели —
-- отдельные сущности.
local function draw(p, team, phase)
	for _, side in { -9, 9 } do
		for _, wheel in { -8, 0, 8 } do
			p.bar(wheel - 3, wheel + 3, side, 4.6, INK)
			p.bar(wheel - 2.3, wheel + 2.3, side, 3.2, IRON[1])
			units.treads(p, wheel - 2.3, wheel + 2.3, side, 1.6, phase, IRON[3])
		end
	end
	p.bar(-12, 12, 0, 15, INK)
	p.bar(-11, 11, 0, 13, STEEL[1])
	p.bar(-11, 11, -5.5, 2, STEEL[2])
	p.bar(-11, -9, 0, 13, team[0])
	p.bar(10, 12, 0, 8, team[2])
	p.beam(0.5, -5.5, 5.5, 1, STEEL[0])
end

local kind = {}

kind.data = {
	speed = 3,
	turn = 2.5,
	radius = 0.8,
	cost = 1200,
	buildTime = 20,
	kind = "vehicle",
	hp = 700,
	materials = { metal = 25, silicon = 8, parts = 1 },
	research = "siege",
	ammo = 120,
	mounts = {
		{ turret = "rocket", along = 0.36, across = -0.27 },
		{ turret = "rocket", along = 0.36, across = 0.27 },
		{ turret = "rocket", along = -0.28, across = -0.27 },
		{ turret = "repair", along = -0.28, across = 0.27 },
	},
	supply = 4,
	motor = "diesel",
	pitch = 0.9,
}

kind.entity = units.entity
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -9, 9 }, width = 3.2 },
	lights = {
		lamps = { { 12, -4.5, 2.5 }, { 12, 4.5, 2.5 } },
		beam = { along = 15, length = 60, near = 6, spread = 0.3, level = 1 },
	},
})

return kind
