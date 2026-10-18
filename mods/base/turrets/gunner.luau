--!strict
-- Пассажир багги с миниганом: лёгкий, разворачивается быстро.

local units = require("lib/units")

local INK, IRON, HAZARD = units.INK, units.IRON, units.HAZARD

-- Пассажир багги: плечи и шлем в цвет команды, миниган — светлый блок стволов с жёлтым дульным срезом.
local function draw(p, team)
	p.beam(0, -3.6, 3.6, 4.4, INK)
	p.beam(0, -2.8, 2.8, 2.8, team[1])
	p.bar(0, 7.5, 1.8, 3, INK)
	p.bar(1, 7, 1.8, 1.4, IRON[4])
	p.dot(7.2, 1.8, 0.8, HAZARD[2])
	p.dot(-1, -0.6, 1.5, INK)
	p.dot(-1, -0.6, 0.9, team[2])
end

local kind = {}

kind.data = {
	turn = 8,
	radius = 0.45,
	weapon = "machinegun",
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)
-- Стрелок не обгорает в остов машины.
kind.look.wreck = false

return kind
