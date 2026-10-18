--!strict
-- Казармы, 3×2: два спальных корпуса с плоскими крышами, между ними штаб со знаменем, перед ними плац с разметкой
-- строя. По плацу ходит часовой.

local b = require("lib/buildings")

local STEEL, IRON, TEAM, INK = b.STEEL, b.IRON, b.TEAM, b.INK
local TURN, round, pulse = b.TURN, b.round, b.pulse

return b.look(3, 2, function(g, t: number)
	b.slab(g, 0, 2, 48, 30, 3, STEEL)

	-- Плац: песчаная площадка с точками строя.
	g:rect(3, 19, 42, 9, 0x6b5a3e)
	g:rect(3, 19, 42, 1, 0x4d4030)
	for x = 7, 43, 5 do
		for _, y in { 22, 25 } do
			g:rect(x, y, 1, 1, 0x8f7a55)
		end
	end
	-- Часовой ходит вдоль плаца туда и обратно.
	local walk = round(6 + 34 * (0.5 - 0.5 * math.cos(TURN * t)))
	g:rect(walk, 22, 3, 3, INK)
	g:rect(walk + 1, 23, 1, 1, TEAM[2])

	-- Спальные корпуса по бокам: крыши с вентиляцией.
	for _, x in { 2, 31 } do
		b.slab(g, x, 3, 15, 15, 3, IRON)
		g:rect(x + 2, 6, 11, 1, IRON[0])
		g:rect(x + 2, 10, 11, 1, IRON[0])
		g:rect(x + 6, 7, 3, 2, IRON[3])
	end
	-- Штаб посередине со знаменем команды.
	b.slab(g, 17, 1, 14, 17, 3, STEEL)
	g:rect(19, 3, 10, 9, TEAM[1])
	g:rect(19, 3, 10, 2, TEAM[2])
	g:rect(23, 6, 2, 3, TEAM[3])
	g:rect(21, 13, 6, 2, INK)
	b.bulb(g, 18, 15, pulse(t))
	b.bulb(g, 28, 15, pulse(t, 0.5))
end)
