--!strict
-- Станция поставки, 3×2 — перенос supplyDepot из buildingArt.ts: бетонная площадка погрузки с разметкой, штабель
-- ящиков с патронами и поворотный кран с излучателем транспортного луча — им станция грузит машины снабжения,
-- вставшие рядом.

local b = require("lib/buildings")

local STEEL, IRON, INK, HAZARD = b.STEEL, b.IRON, b.INK, b.HAZARD
local TURN, round, pulse, chase = b.TURN, b.round, b.pulse, b.chase

return b.look(3, 2, function(g, t: number)
	local tint = b.accent(b.GOOD_COLORS.ammo)
	b.slab(g, 0, 1, 48, 31, 3, IRON)
	-- Площадка погрузки справа: жёлто-чёрная рамка, внутри — бетон.
	g:rect(24, 4, 21, 22, INK)
	g:rect(25, 5, 19, 20, IRON[2])
	for i = 0, 18, 4 do
		g:rect(25 + i, 5, 2, 1, HAZARD[1])
		g:rect(25 + i, 24, 2, 1, HAZARD[1])
	end
	for i = 0, 19, 4 do
		g:rect(25, 5 + i, 1, 2, HAZARD[1])
		g:rect(43, 5 + i, 1, 2, HAZARD[1])
	end
	g:rect(27, 7, 15, 16, IRON[1])
	-- Штабель ящиков слева, три ряда по три.
	for row = 0, 2 do
		for col = 0, 2 do
			local x, y = 3 + col * 6, 4 + row * 7
			g:rect(x, y, 6, 6, INK)
			g:rect(x + 1, y + 1, 4, 4, tint[1])
			g:rect(x + 1, y + 1, 4, 1, tint[2])
			g:rect(x + 2, y + 3, 2, 1, tint[0])
		end
	end
	-- Поворотный кран между штабелем и площадкой: стрела ходит над площадкой, на конце — излучатель луча.
	local angle = -math.pi / 4 + math.sin(TURN * t) * 0.6
	local baseX, baseY = 22, 15
	local tipX = baseX + math.cos(angle) * 12
	local tipY = baseY + math.sin(angle) * 12 + 4
	g:line(baseX, baseY, tipX, tipY, 3, INK)
	g:line(baseX, baseY, tipX, tipY, 1, HAZARD[1])
	b.tower(g, baseX, baseY + 2, 3, 2, STEEL)
	g:circle(tipX, tipY, 2.2, INK)
	g:circle(tipX, tipY, 1.4, 0x5ff2d0)
	g:light(round(tipX), round(tipY), 2, 0.4 + 0.4 * pulse(t * 2))
	-- Огни погрузки по углам площадки бегут по кругу.
	local corners = { { 26, 6 }, { 42, 6 }, { 42, 22 }, { 26, 22 } }
	for i, at in corners do
		b.bulb(g, at[1] - 1, at[2] - 1, chase(t, (i - 1) / #corners))
	end
end)
