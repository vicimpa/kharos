--!strict
-- Та же пушка на крыше MCV, ещё без оружия: заработает, когда MCV развернётся в главное здание.
-- Данные — packages/base/data/turrets.json, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	turn = 2.5,
	radius = 0.9,
}

kind.entity = units.turretEntity
kind.look = units.turretLook("mcv")

return kind
