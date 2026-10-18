--!strict
-- Склад кремния, 2×2 — перенос siliconStore из buildingArt.ts: белый герметичный корпус с боксами под стеклом,
-- чистый воздух гонят фильтры.

local b = require("lib/buildings")

local INK = b.INK
local FRAMES, pulse = b.FRAMES, b.pulse
local WHITE = { [0] = 0x6d7680, 0x9aa4ae, 0xc3cbd3, 0xe1e7ec, 0xffffff }

return b.look(2, 2, function(g, t: number)
	local tint = b.accent(b.goodColor("silicon"))
	b.slab(g, 0, 1, 32, 31, 3, WHITE)
	-- Боксы: окна в корпусе, за стеклом — стопки пластин.
	for _, at in { { 3, 4 }, { 17, 4 }, { 3, 15 }, { 17, 15 } } do
		local x, y = at[1], at[2]
		g:rect(x, y, 12, 9, INK)
		g:rect(x + 1, y + 1, 10, 7, 0x1a2a38)
		for k = 0, 2 do
			g:rect(x + 2 + k * 3, y + 3, 2, 4, tint[1])
			g:rect(x + 2 + k * 3, y + 3, 2, 1, tint[2])
		end
		g:rect(x + 1, y + 1, 3, 1, 0x5a7a90)
	end
	-- Фильтры на крыше: решётки вентиляторов, огонёк чистоты.
	for _, x in { 8, 22 } do
		g:circle(x, 27, 2, INK)
		g:rect(x - 1, 27 - (math.floor(t * FRAMES) % 2), 2, 1, WHITE[3])
	end
	b.bulb(g, 14, 26, pulse(t))
end)
