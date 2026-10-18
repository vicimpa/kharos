--!strict
-- Плавильня, 3×3: открытая ванна жидкого металла — сверху видно раскалённое зеркало с коркой шлака, — жёлоб из неё на
-- конвейер изложниц, где слитки остывают, и штабель готовых слитков.

local b = require("lib/buildings")

local IRON, RUST, INK, BRICK, FIRE = b.IRON, b.RUST, b.INK, b.BRICK, b.FIRE
local TURN, FRAMES, round, hash, pulse, fireColor = b.TURN, b.FRAMES, b.round, b.hash, b.pulse, b.fireColor

return b.look(3, 3, function(g, t: number, working: boolean)
	local tint = b.accent(b.goodColor("metal"))
	local frame = math.floor(t * FRAMES)
	b.slab(g, 0, 2, 48, 46, 3, IRON)
	g:rect(2, 4, 44, 1, RUST[0])

	-- Ванна: кирпичное кольцо, внутри металл. В работе он ярко светится и по нему плывёт шлак; в простое — остывшая корка.
	local cx, cy = 16, 18
	g:circle(cx, cy, 14, INK)
	g:circle(cx, cy, 13, BRICK[1])
	g:circle(cx - 1, cy - 1, 12, BRICK[2])
	g:circle(cx, cy, 10, INK)
	g:circle(cx, cy, 9, if working then fireColor(0.55) else fireColor(0.05))
	g:circle(cx - 1, cy - 1, 7, if working then fireColor(0.75) else 0x3a2a26)
	g:circle(cx - 2, cy - 2, 4, if working then fireColor(0.95) else 0x4a3530)
	for i = 0, 4 do
		-- Корка шлака: в работе кружит по зеркалу, в простое лежит и чуть тлеет трещинами.
		local angle = TURN * ((if working then t else 0) + i / 5)
		local reach = 4 + hash(i, 1) * 4
		local x = round(cx + math.cos(angle) * reach)
		local y = round(cy + math.sin(angle) * reach)
		g:rect(x, y, 2, 1, if working then FIRE[1] else fireColor(0.25 + 0.15 * pulse(t, i / 5)))
	end
	if working then
		-- Пузырь лопается в случайном месте каждые пару кадров.
		local bubble = math.floor(frame / 2)
		g:rect(round(cx - 5 + hash(bubble, 7) * 10), round(cy - 5 + hash(bubble, 9) * 10), 1, 1, FIRE[4])
	end
	g:light(cx, cy, 8, if working then 0.8 + 0.2 * pulse(t * 2) else 0.15)

	-- Жёлоб из ванны вправо, на конвейер.
	g:rect(29, 15, 7, 4, INK)
	g:rect(29, 16, 7, 2, if working then fireColor(0.7 + 0.25 * pulse(t * 4)) else BRICK[0])

	-- Конвейер изложниц вдоль правого края: формы едут вниз, металл в них остывает от огня к цвету металла.
	g:rect(35, 5, 10, 38, INK)
	g:rect(36, 6, 8, 36, IRON[0])
	local shift = if working then frame % 6 else 0
	for k = 0, 6 do
		local y = 6 + k * 6 + shift - 6
		if y < 6 or y > 38 then
			continue
		end
		g:rect(37, y, 6, 4, IRON[2])
		g:rect(38, y + 1, 4, 2, if k < 2 and working then fireColor(0.9 - k * 0.3) elseif k < 4 and working then FIRE[1] else tint[1])
		g:rect(38, y + 1, 4, 1, if k < 2 and working then FIRE[4] else tint[2])
	end

	-- Штабель готовых слитков внизу слева.
	for _, at in { { 4, 38 }, { 11, 38 }, { 18, 38 }, { 7, 35 }, { 14, 35 }, { 10, 32 } } do
		local x, y = at[1], at[2]
		g:rect(x, y, 7, 4, INK)
		g:rect(x + 1, y + 1, 5, 2, tint[1])
		g:rect(x + 1, y + 1, 5, 1, tint[2])
	end
	b.lamp(g, 29, 40, 2, pulse(t))
end, { working = true })
