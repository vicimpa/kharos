--!strict
-- Танковая башня: тяжёлая, поворачивается медленно, ядро вылетает с конца длинного ствола.

local units = require("lib/units")

local INK, STEEL, IRON = units.INK, units.STEEL, units.IRON

-- Танковая башня: круглая, с люком и длинным стволом с дульным тормозом.
local function draw(p, team)
	p.bar(2, 13, 0, 3.6, INK)
	p.bar(2, 12.5, 0, 1.6, IRON[3])
	p.bar(11.5, 14, 0, 4.4, INK)
	p.bar(12, 13.5, 0, 2.6, IRON[2])
	p.dot(0, 0, 5.4, INK)
	p.dot(0, 0, 4.4, STEEL[2])
	p.dot(-1, 0, 3.4, team[0])
	p.dot(-1.5, -1.5, 1.6, team[1])
	p.dot(-2, 1.5, 1, IRON[4])
end

local kind = {}

kind.data = {
	turn = 2,
	radius = 0.85,
	weapon = "cannon",
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)

return kind
