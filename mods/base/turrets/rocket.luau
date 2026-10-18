--!strict
-- Ракетная турель: блок с двумя пусковыми трубами на носителе.

local units = require("lib/units")

local INK, IRON, HAZARD = units.INK, units.IRON, units.HAZARD

-- Ракетная турель: квадратный блок с двумя пусковыми трубами.
local function draw(p, team)
	p.bar(-3, 3, 0, 6.4, INK)
	p.bar(-2.4, 2.4, 0, 5, team[0])
	p.bar(-2.4, -1.2, 0, 5, team[1])
	for _, side in { -1.5, 1.5 } do
		p.bar(0, 6, side, 2.2, INK)
		p.bar(0.5, 5.5, side, 1, IRON[4])
		p.dot(5.6, side, 0.6, HAZARD[2])
	end
end

local kind = {}

kind.data = {
	turn = 4,
	radius = 0.2,
	weapon = "launcher",
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)

return kind
