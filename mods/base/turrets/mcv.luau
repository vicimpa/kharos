--!strict
-- Та же пушка на крыше MCV, ещё без оружия: заработает, когда MCV развернётся в главное здание.

local units = require("lib/units")

-- Та же пушка главного здания на крыше MCV.
local function draw(p, team)
	units.coreGun(p, 0, 14, team)
end

local kind = {}

kind.data = {
	turn = 2.5,
	radius = 0.9,
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)

return kind
