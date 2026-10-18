--!strict
-- Ремонтная станция, 3×3 — перенос repairStation из buildingArt.ts: площадка обслуживания в жёлто-чёрной разметке
-- с поворотным кругом, над ней портал, по балке которого ездит сварочная головка и сыплет искрами; в углу — будка
-- оператора и стойка баллонов.

local b = require("lib/buildings")

local STEEL, IRON, TEAM, INK, HAZARD, BRICK = b.STEEL, b.IRON, b.TEAM, b.INK, b.HAZARD, b.BRICK
local TURN, round, pulse, chase = b.TURN, b.round, b.pulse, b.chase

return b.look(3, 3, function(g, t: number)
	b.slab(g, 0, 2, 48, 46, 3, STEEL)

	-- Площадка: разметка по краю и поворотный круг посередине.
	g:rect(3, 12, 32, 31, INK)
	g:rect(4, 13, 30, 29, HAZARD[0])
	for i = 0, 29, 4 do
		g:rect(4 + i, 13, 2, 2, HAZARD[1])
		g:rect(4 + i, 40, 2, 2, HAZARD[1])
	end
	for i = 0, 25, 4 do
		g:rect(4, 15 + i, 2, 2, HAZARD[1])
		g:rect(32, 15 + i, 2, 2, HAZARD[1])
	end
	g:rect(7, 16, 24, 23, IRON[1])
	g:circle(19, 27, 10, INK)
	g:circle(19, 27, 9, IRON[2])
	g:circle(19, 27, 7, IRON[1])
	-- Круг медленно поворачивается: по нему бегут четыре метки.
	for i = 0, 3 do
		local a = TURN * (t + i / 4)
		g:rect(round(19 + math.cos(a) * 8) - 1, round(27 + math.sin(a) * 8) - 1, 2, 2, IRON[4])
	end
	g:rect(16, 24, 6, 6, IRON[3])
	g:rect(17, 25, 4, 4, IRON[2])

	-- Портал: две стойки и балка поперёк площадки.
	for _, x in { 5, 31 } do
		g:rect(x - 1, 8, 4, 30, INK)
		g:rect(x, 9, 2, 28, HAZARD[1])
		g:rect(x, 9, 1, 28, 0xf0d060)
	end
	g:rect(4, 7, 30, 5, INK)
	g:rect(5, 8, 28, 3, IRON[3])
	g:rect(5, 8, 28, 1, IRON[4])
	-- Головка ездит по балке туда и обратно; трос опускает её к кругу.
	local head = round(19 + math.sin(TURN * t) * 9)
	g:rect(head - 3, 6, 6, 6, INK)
	g:rect(head - 2, 7, 4, 4, STEEL[3])
	g:rect(head, 12, 1, 9, IRON[0])
	g:rect(head - 1, 21, 3, 3, INK)
	g:rect(head, 22, 1, 1, TEAM[3])
	-- Искры сварки вспыхивают и разлетаются вниз.
	local spark = chase(t * 4, 0)
	g:light(head, 23, 3, 0.3 + 0.7 * spark)
	if spark > 0.2 then
		g:rect(head - 2, 24, 1, 1, 0xfff0b0)
		g:rect(head + 2, 25, 1, 1, 0xffd36a)
		g:rect(head - 1, 26, 1, 1, 0xf08a2a)
	end

	-- Будка оператора с окном и стойка баллонов.
	b.slab(g, 36, 6, 10, 16, 4, IRON)
	g:rect(38, 9, 6, 3, TEAM[1])
	g:rect(38, 9, 6, 1, TEAM[2])
	b.lamp(g, 41, 4, 1, pulse(t * 2))
	for i = 0, 2 do
		b.tower(g, 38 + i * 3, 38, 1, 8, if i == 1 then BRICK else STEEL)
	end
	for i = 0, 2 do
		b.bulb(g, 37, 25 + i * 4, chase(t, i / 3))
	end
end)
