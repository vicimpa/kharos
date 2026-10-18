--!strict
-- Покрытие на земле: фундамент, дорога и мост — по 16 фаз, на каждый набор соседей (lib/paveArt). Рисует effects/paving
-- своим слоем pave — под следами, грузом на земле и зданиями.

local paveArt = require("lib/paveArt")

local function draw(g, _, phase: number)
	paveArt.draw(g, paveArt.LOOKS[phase // 16 + 1], phase % 16)
end

return {
	look = { size = 16, origin = { 0, 0 }, anchor = { 8, 8 }, phases = 48, layer = "pave", draw = draw },
}
