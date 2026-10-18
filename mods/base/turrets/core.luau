--!strict
-- Пушка главного здания: тяжёлый купол со спаренным излучателем. Чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 2.5,
	radius = 0.9,
	weapon = "coreGun",
}

kind.entity = units.turretEntity
kind.look = units.turretLook("core")

return kind
