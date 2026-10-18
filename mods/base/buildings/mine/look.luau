--!strict
-- Шахта, 2×2 — перенос mine из buildingArt.ts: ствол под копром со шкивом и бункер, куда лента поднимает руду. Руда —
-- цвета своего месторождения: вариант — номер руды в ORES плюс один, 0 — руда неизвестна. В работе шкив крутится, по
-- тросу ходит бадья, по ленте бежит руда, над стволом клубится пыль и мигают огни; стоящая — шкив замер, бадья
-- наверху, лента пуста, огни едва тлеют.

local b = require("lib/buildings")

local STEEL, IRON, RUST, INK, DARK, GOLD = b.STEEL, b.IRON, b.RUST, b.INK, b.DARK, b.GOLD
local TURN, FRAMES, round, pulse, chase = b.TURN, b.FRAMES, b.round, b.pulse, b.chase

return b.look(2, 2, function(g, t: number, working: boolean, variant: number)
	local ore = if variant ~= 0 then b.accent(b.GOOD_COLORS[b.ORES[variant]]) else RUST
	b.slab(g, 0, 1, 32, 31, 3, STEEL)

	-- Ствол шахты и лента от него к бункеру: в работе по ней идёт руда.
	g:rect(4, 12, 14, 14, INK)
	g:rect(5, 13, 12, 12, DARK)
	g:rect(5, 13, 12, 1, IRON[1])
	g:rect(17, 19, 7, 5, INK)
	g:rect(17, 20, 7, 3, IRON[0])
	local step = math.floor(t * FRAMES) % 8
	if working then
		for _, at in { step, (step + 4) % 8 } do
			if at >= 6 then
				continue
			end
			g:rect(17 + at, 20, 2, 2, ore[1])
			g:rect(17 + at, 20, 1, 1, ore[2])
		end
	end

	-- Бункер с рудой.
	b.slab(g, 21, 10, 10, 18, 4, IRON)
	g:rect(23, 12, 6, 9, DARK)
	for _, at in { { 23, 17 }, { 26, 16 }, { 24, 19 }, { 27, 19 }, { 25, 13 } } do
		g:rect(at[1], at[2], 2, 2, ore[1])
		g:rect(at[1], at[2], 1, 1, ore[2])
	end

	-- Пыль над стволом: в работе — клубы, поднимающиеся от устья.
	if working then
		for i = 0, 2 do
			local rise = (math.floor(t * FRAMES) + i * 5) % 8
			if rise > 5 then
				continue
			end
			g:rect(6 + i * 4 + (rise % 2), 14 - rise, 2, 1, if rise < 3 then IRON[4] else IRON[3])
		end
	end

	-- Копёр: две ноги сходятся к шкиву над стволом.
	for _, x in { 5, 16 } do
		g:line(x, 24, 11, -2, 3, INK)
		g:line(x, 24, 11, -2, 1.2, IRON[3])
	end
	g:rect(6, 10, 10, 1, IRON[2])
	g:circle(11, -2, 5, INK)
	g:circle(11, -2, 4, IRON[1])
	-- У шкива четыре спицы: четверть оборота замыкает цикл. Стоящая шахта шкив не крутит.
	local angle = if working then t * TURN * 0.25 else TURN / 8
	for _, turn in { angle, angle + TURN / 4 } do
		local dx, dy = math.cos(turn) * 3.5, math.sin(turn) * 3.5
		g:line(11 - dx, -2 - dy, 11 + dx, -2 + dy, 1.2, IRON[4])
	end
	-- Бадья на тросе — поверх копра: в работе ходит по стволу вниз и вверх, поднимая руду, стоящая — поднята.
	local swing = (t * 2) % 1
	local depth = if working then round((if swing < 0.5 then swing * 2 else 2 - swing * 2) * 9) else 0
	g:rect(11, 3, 1, 7 + depth, IRON[2])
	g:rect(8, 9 + depth, 7, 5, INK)
	g:rect(9, 10 + depth, 5, 3, IRON[2])
	g:rect(9, 10 + depth, 5, 1, IRON[3])
	if working and swing >= 0.5 then
		g:rect(10, 10 + depth, 3, 1, ore[2])
	end

	-- Маячок на бункере: в работе мигает жёлтым, стоящая шахта его гасит.
	local beacon = if working then chase(t * 2, 0) else 0
	g:light(26, 9, 2, beacon * 0.8)
	g:rect(24, 7, 5, 3, INK)
	g:rect(25, 8, 3, 2, if beacon > 0.3 then GOLD[2] elseif beacon > 0 then GOLD[1] else bit32.band(GOLD[0], 0x5f5f5f))
	b.bulb(g, 2, 6, if working then pulse(t) else 0.08)
end, { working = true, variants = #b.ORES + 1 })
