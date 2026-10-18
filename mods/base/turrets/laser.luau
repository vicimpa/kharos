--!strict
-- Лазерная турель: купол с одним излучателем, поворачивается быстро.
-- Данные — packages/base/data/turrets.json, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 4,
	radius = 0.6,
	weapon = "laser",
}

kind.entity = units.turretEntity
kind.look = units.turretLook("laser")

return kind
