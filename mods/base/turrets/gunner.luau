--!strict
-- Пассажир багги с миниганом: лёгкий, разворачивается быстро.
-- Данные — packages/base/data/turrets.json, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 8,
	radius = 0.45,
	weapon = "machinegun",
}

kind.entity = units.turretEntity
kind.look = units.turretLook("gunner")

return kind
