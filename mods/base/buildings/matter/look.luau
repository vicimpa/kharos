--!strict
-- Генератор материи, 2×2 — перенос matter из buildingArt.ts: камера синтеза с пульсирующим ядром в кольце огней,
-- катушки по углам и короткая лента, по которой готовый слиток уезжает в приёмный люк.

local b = require("lib/buildings")

local STEEL, IRON, RUST, INK, DARK, GOLD = b.STEEL, b.IRON, b.RUST, b.INK, b.DARK, b.GOLD
local TURN, FRAMES = b.TURN, b.FRAMES

return b.look(2, 2, function(g, t: number)
	b.slab(g, 0, 1, 32, 31, 3, STEEL)

	-- Лента от камеры к люку у нижнего края: за цикл по ней проезжает один слиток.
	g:rect(10, 18, 12, 10, INK)
	g:rect(11, 19, 10, 8, IRON[0])
	for y = 20, 26, 2 do
		g:rect(11, y, 10, 1, IRON[1])
	end
	local y = 17 + math.floor(t * FRAMES) % 8
	g:rect(13, y, 6, 3, INK)
	g:rect(13, y, 6, 2, GOLD[1])
	g:rect(13, y, 3, 1, GOLD[2])
	g:rect(13, y + 2, 6, 1, GOLD[0])
	g:rect(9, 25, 14, 4, INK)
	g:rect(10, 26, 12, 2, DARK)
	g:rect(10, 26, 12, 1, RUST[1])

	-- Камера синтеза выше двора и выступает над основанием.
	b.slab(g, 3, -5, 26, 26, 5, IRON)
	g:circle(16, 6, 10, INK)
	g:circle(16, 6, 9, DARK)
	g:ring(16, 6, 8, 1.5, STEEL[2])
	-- Огни кольца бегут навстречу друг другу к ядру: энергия стекается внутрь.
	local LIGHTS = 8
	for i = 0, LIGHTS - 1 do
		local angle = (i / LIGHTS) * TURN
		local x = b.round(16 + math.cos(angle) * 8)
		local lightY = b.round(6 + math.sin(angle) * 8)
		b.bulb(g, x - 1, lightY - 1, b.chase(t * 2, (i % 4) / 4))
	end
	-- Ядро: золотое, когда материя готова, и гаснет к следующей порции.
	local glow = b.pulse(t * 2)
	b.lamp(g, 16, 6, 4, 0.35 + glow * 0.65)
	g:circle(16, 6, 2, GOLD[if glow > 0.5 then 1 else 0])
	if glow > 0.8 then
		g:rect(15, 5, 1, 1, GOLD[2])
	end

	-- Катушки по нижним углам.
	for _, coil in { { 4, 0 }, { 28, 0.5 } } do
		local x, offset = coil[1], coil[2]
		b.tower(g, x, 26, 2, 4, STEEL)
		b.bulb(g, x - 1, 20, b.pulse(t * 2, offset))
	end
end)
