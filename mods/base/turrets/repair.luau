--!strict
-- Ремонтная турель: чинит своё вокруг носителя, и на ходу тоже.

local units = require("lib/units")

local INK, IRON, HAZARD = units.INK, units.IRON, units.HAZARD

-- Ремонтная турель: жёлтый купол с рукой-излучателем.
local function draw(p)
	p.bar(0, 5.5, 0, 2.2, INK)
	p.bar(0, 5, 0, 1, IRON[3])
	p.dot(5.6, 0, 1.5, INK)
	p.dot(5.6, 0, 0.9, 0x7dffa8)
	p.dot(-0.5, 0, 3.4, INK)
	p.dot(-0.5, 0, 2.6, HAZARD[1])
	p.dot(-1.2, -0.8, 1, HAZARD[2])
end

local kind = {}

kind.data = {
	turn = 4,
	radius = 0.2,
	repair = 5,
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)

return kind
