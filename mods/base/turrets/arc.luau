--!strict
-- Разрядная башня: катушка с двумя электродами, разряд срывается с их концов. Чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 3,
	radius = 0.7,
	weapon = "arc",
}

kind.entity = units.turretEntity
kind.look = units.turretLook("arc")

return kind
