--!strict
-- Склад стройблоков, 2×2: двор с поддонами кирпичных блоков и погрузчиком, который их развозит.

local b = require("lib/buildings")

local IRON, RUST, INK, HAZARD = b.IRON, b.RUST, b.INK, b.HAZARD
local TURN, round, pulse = b.TURN, b.round, b.pulse

return b.look(2, 2, function(g, t: number)
	local tint = b.accent(b.goodColor("blocks"))
	b.slab(g, 0, 1, 32, 31, 3, IRON)
	g:rect(2, 3, 28, 22, IRON[1])
	-- Поддоны: деревянная решётка, на ней кладка блоков со швами.
	for _, at in { { 3, 4 }, { 17, 4 }, { 3, 14 }, { 17, 14 } } do
		local x, y = at[1], at[2]
		g:rect(x, y, 12, 9, INK)
		g:rect(x + 1, y + 7, 10, 1, RUST[1])
		for row = 0, 2 do
			for k = 0, 2 do
				local bx = x + 1 + k * 3 + (row % 2)
				g:rect(bx, y + 1 + row * 2, 3, 2, if row == 0 then tint[2] else tint[1])
				g:rect(bx + 2, y + 1 + row * 2, 1, 2, tint[0])
			end
		end
	end
	-- Погрузчик ездит по проходу внизу.
	local x = round(4 + 20 * (0.5 - 0.5 * math.cos(TURN * t)))
	g:rect(x, 26, 5, 3, INK)
	g:rect(x + 1, 26, 3, 2, HAZARD[1])
	b.bulb(g, 28, 27, pulse(t))
end)
