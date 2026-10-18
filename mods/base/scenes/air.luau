--!strict
-- Сценка витрины: бой в воздухе — дроны и штурмовики против них и ракетчиков.

local battle = require("lib/battle")

return battle.scene(3000, { drone = 2, gunship = 1, rocketeer = 1 })
