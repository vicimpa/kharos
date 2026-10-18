--!strict
-- Разрядная башня: катушка с двумя электродами, разряд срывается с их концов.

local units = require("lib/units")

local INK, IRON, ENERGY = units.INK, units.IRON, units.ENERGY

-- Разрядная башня: катушка на кольце и два электрода вперёд со светящимися концами.
local function draw(p, team)
	for _, side in { -2.6, 2.6 } do
		p.bar(2, 11, side, 2.6, INK)
		p.bar(2, 10, side, 1.2, IRON[3])
		p.dot(11, side, 1.4, ENERGY[1])
		p.dot(11, side, 0.6, ENERGY[2])
	end
	p.dot(0, 0, 5.4, INK)
	p.dot(0, 0, 4.6, IRON[2])
	p.beam(-3.5, -2.5, 2.5, 1.4, team[0])
	p.dot(0, 0, 3.4, INK)
	p.dot(0, 0, 2.6, ENERGY[0])
	p.dot(0, 0, 1.2, ENERGY[2])
end

local kind = {}

kind.data = {
	turn = 3,
	radius = 0.7,
	weapon = "arc",
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)

return kind
