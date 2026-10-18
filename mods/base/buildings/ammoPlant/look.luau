--!strict
-- Патронный цех, 2×2: бункер пороха, по ленте рядами едут латунные гильзы, на краях — полосы опасности.

local b = require("lib/buildings")

local IRON, RUST, INK, HAZARD = b.IRON, b.RUST, b.INK, b.HAZARD
local FRAMES, pulse, chase = b.FRAMES, b.pulse, b.chase

return b.look(2, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.goodColor("ammo"))
	b.slab(g, 0, 2, 32, 30, 3, IRON)
	for x = 2, 29, 4 do
		g:rect(x, 26, 2, 2, HAZARD[1])
		g:rect(x + 2, 26, 2, 2, HAZARD[0])
	end

	-- Бункер пороха: воронка сверху, тёмная засыпка; в работе из горла сыплется порох.
	g:rect(2, 4, 11, 11, INK)
	g:rect(3, 5, 9, 9, IRON[2])
	g:rect(5, 7, 5, 5, IRON[1])
	g:rect(6, 8, 3, 3, 0x1a1a1a)
	if working then
		g:rect(7, 9 + (math.floor(t * FRAMES) % 2), 1, 1, IRON[3])
	end
	-- Подача с бункера на ленту.
	g:rect(13, 8, 4, 3, INK)
	g:rect(13, 9, 4, 1, RUST[1])

	-- Лента: три ряда гильз, в работе ползут вниз; донца гильз сверху — латунные кружки.
	g:rect(16, 4, 14, 21, INK)
	g:rect(17, 5, 12, 19, IRON[0])
	local shift = if working then math.floor(t * FRAMES) % 4 else 0
	for row = 0, 5 do
		local y = 5 + row * 4 + shift - 2
		if y < 5 or y > 21 then
			continue
		end
		for col = 0, 2 do
			local x = 19 + col * 4
			g:circle(x, y + 1, 1.5, tint[0])
			g:rect(x, y + 1, 1, 1, if row > 2 then tint[2] else IRON[3])
		end
	end
	-- Готовые ящики с патронами внизу слева.
	for _, x in { 3, 9 } do
		g:rect(x, 17, 6, 7, INK)
		g:rect(x + 1, 18, 4, 5, 0x3d4a2a)
		g:rect(x + 1, 20, 4, 1, tint[1])
	end
	b.lamp(g, 29, 3, 1, pulse(t * (if working then 3 else 1)))
	b.bulb(g, 14, 13, if working then chase(t, 0.5) else 0)
end, { working = true })
