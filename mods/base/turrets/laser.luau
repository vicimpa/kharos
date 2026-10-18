--!strict
-- Лазерная турель: купол с одним излучателем, поворачивается быстро.

local units = require("lib/units")

local INK, STEEL, IRON, ENERGY = units.INK, units.STEEL, units.IRON, units.ENERGY

-- Лазерная турель: купол цвета команды и один излучатель с голубой линзой на конце.
local function draw(p, team)
	p.bar(1, 10, 0, 2.6, INK)
	p.bar(1.5, 9.5, 0, 1.2, IRON[3])
	p.dot(10, 0, 1.4, ENERGY[1])
	p.dot(10, 0, 0.7, ENERGY[2])
	p.dot(0, 0, 4.6, INK)
	p.dot(0, 0, 3.8, STEEL[2])
	p.dot(-0.6, 0, 2.8, team[0])
	p.dot(-1.2, -1.2, 1.1, team[1])
end

local kind = {}

kind.data = {
	turn = 4,
	radius = 0.6,
	weapon = "laser",
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)

return kind
