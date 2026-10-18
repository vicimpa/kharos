--!strict
-- Кремниевый завод, 3×2 — перенос siliconWorks из buildingArt.ts: дуговая печь — три электрода в тигле, между ними
-- трещат разряды, — две камеры, где из расплава тянут кристаллы, и стопки готовых пластин.

local b = require("lib/buildings")

local IRON, INK, ARC = b.IRON, b.INK, b.ARC
local TURN, FRAMES, round, hash, pulse, fireColor = b.TURN, b.FRAMES, b.round, b.hash, b.pulse, b.fireColor
local WHITE = { [0] = 0x6d7680, 0x9aa4ae, 0xc3cbd3, 0xe1e7ec, 0xffffff }

return b.look(3, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.GOOD_COLORS.silicon)
	local frame = math.floor(t * FRAMES)
	b.slab(g, 0, 2, 48, 30, 3, WHITE)

	-- Тигель печи с расплавом.
	local cx, cy = 14, 15
	g:circle(cx, cy, 12, INK)
	g:circle(cx, cy, 11, IRON[1])
	g:circle(cx - 1, cy - 1, 10, IRON[2])
	g:circle(cx, cy, 8, INK)
	-- Расплав кварца рыжий от жара: на нём голубые дуги видны, а цвет кремния — у кристаллов и пластин.
	g:circle(cx, cy, 7, if working then fireColor(0.45) else 0x262a30)
	g:circle(cx - 1, cy - 1, 4, if working then fireColor(0.7) else 0x30353c)
	-- Три электрода треугольником; в работе между ними и к расплаву бьют дуги, каждые два кадра — новые.
	local electrodes = {}
	for i = 0, 2 do
		local angle = TURN * (i / 3) - TURN / 4
		electrodes[i] = { round(cx + math.cos(angle) * 5), round(cy + math.sin(angle) * 5) }
	end
	if working then
		local beat = math.floor(frame / 2)
		for i = 0, 2 do
			local x0, y0 = electrodes[i][1], electrodes[i][2]
			local x1, y1 = electrodes[(i + 1) % 3][1], electrodes[(i + 1) % 3][2]
			local bend = (hash(beat, i) - 0.5) * 4
			local mx = (x0 + x1) / 2 + (cx - (x0 + x1) / 2) * 0.3 + bend
			local my = (y0 + y1) / 2 + (cy - (y0 + y1) / 2) * 0.3 - bend
			g:line(x0, y0, mx, my, 1.5, if hash(beat, i + 5) > 0.3 then ARC[2] else ARC[1])
			g:line(mx, my, x1, y1, 1.5, ARC[2])
			g:rect(round(mx), round(my), 1, 1, ARC[2])
		end
	end
	for i = 0, 2 do
		local x, y = electrodes[i][1], electrodes[i][2]
		g:circle(x, y, 2, INK)
		g:circle(x, y, 1.5, if working then ARC[1] else IRON[4])
	end
	g:light(cx, cy, 6, if working then 0.6 + 0.4 * hash(math.floor(frame / 2), 11) else 0)

	-- Камеры выращивания: круглые колпаки со смотровым окном, в работе внутри светится тянущийся кристалл.
	for _, chamber in { { 33, 10, 0 }, { 33, 22, 0.5 } } do
		local x, y, offset = chamber[1], chamber[2], chamber[3]
		g:circle(x, y, 5, INK)
		g:circle(x, y, 4, WHITE[2])
		g:circle(x - 1, y - 1, 2, WHITE[4])
		g:circle(x, y, 2, if working then tint[1] else WHITE[0])
		if working then
			g:rect(x, y - 1 + round(pulse(t, offset)), 1, 1, tint[2])
		end
	end
	-- Стопки готовых пластин: тонкие диски цвета кремния.
	for _, at in { { 42, 9 }, { 42, 17 }, { 42, 25 } } do
		local x, y = at[1], at[2]
		g:circle(x, y, 3, INK)
		g:circle(x, y, 2, tint[1])
		g:rect(x - 1, y - 2, 2, 1, tint[2])
	end
	b.lamp(g, 26, 26, 1, pulse(t))
end, { working = true })
