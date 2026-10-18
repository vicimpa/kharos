--!strict
-- Пушка главного здания: тяжёлый купол со спаренным излучателем.
-- Данные — packages/base/data/turrets.json, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	about = "Пушка главного здания: тяжёлый купол со спаренным излучателем.",
	turn = 2.5,
	radius = 0.9,
	weapon = "coreGun",
}

kind.entity = units.turretEntity
kind.look = units.turretLook("core")

return kind
