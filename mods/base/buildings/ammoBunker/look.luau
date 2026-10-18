--!strict
-- Бункер боеприпасов, 2×1 — перенос ammoBunker из buildingArt.ts: заглублённый бетонный каземат с полосами опасности
-- и бронедверью.

local b = require("lib/buildings")

local IRON, INK, HAZARD = b.IRON, b.INK, b.HAZARD
local pulse = b.pulse

return b.look(2, 1, function(g, t: number)
	local tint = b.accent(b.GOOD_COLORS.ammo)
	b.slab(g, 0, 1, 32, 15, 2, IRON)
	-- Обвалование: земляной вал вокруг крыши.
	g:rect(2, 3, 28, 9, 0x4d4030)
	g:rect(4, 4, 24, 7, IRON[2])
	g:rect(4, 4, 24, 1, IRON[3])
	-- Полосы опасности по краю крыши.
	for x = 4, 27, 4 do
		g:rect(x, 10, 2, 1, HAZARD[1])
	end
	-- Ящики у входа и бронедверь.
	for _, x in { 6, 10 } do
		g:rect(x, 6, 3, 3, INK)
		g:rect(x, 6, 2, 2, tint[1])
		g:rect(x, 6, 2, 1, tint[2])
	end
	g:rect(18, 5, 8, 5, INK)
	g:rect(19, 6, 6, 3, IRON[1])
	g:rect(21, 7, 2, 1, HAZARD[1])
	-- Красная лампа «взрывоопасно» мигает.
	local level = pulse(t * 2)
	g:rect(28, 5, 2, 2, if level > 0.5 then 0xff6b5a else 0x6a1a10)
	g:light(29, 6, 1, level * 0.5)
end)
