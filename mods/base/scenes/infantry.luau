--!strict
-- Сценка витрины: бой пехоты — стрелки и ракетчики.

local battle = require("lib/battle")

return battle.scene(1500, { infantry = 2, rocketeer = 1 })
