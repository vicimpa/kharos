--!strict
-- Пушка главного здания: тяжёлый купол со спаренным излучателем.

local units = require("lib/units")

-- Пушка главного здания: широкий купол цвета команды с линзой и спаренный излучатель.
local function draw(p, team)
	units.coreGun(p, 0, 14, team)
end

local kind = {}

kind.data = {
	turn = 2.5,
	radius = 0.9,
	weapon = "coreGun",
}

kind.entity = units.turretEntity
kind.look = units.turretLook(draw)

return kind
