--!strict
-- Сценка витрины: бой бронетехники — танки, копейщики, тесла, носители и багги (armor в sim-ts/showcase.ts).

local battle = require("lib/battle")

return battle.scene(4000, { tank = 2, lancer = 1, tesla = 1, carrier = 1, buggy = 1 })
