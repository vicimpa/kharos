--!strict
-- Накопитель энергии, 2×2 — перенос accumulator из buildingArt.ts: шесть банок в стойке под общей шиной; по банкам
-- снизу вверх бежит заряд цвета команды, на конце шины мигает огонёк.

local b = require("lib/buildings")

local STEEL, RUST, INK = b.STEEL, b.RUST, b.INK
local round, pulse, teamColor = b.round, b.pulse, b.teamColor

return b.look(2, 2, function(g, t: number)
	local tint = b.accent(b.goodColor("lithium"))
	b.slab(g, 0, 2, 32, 30, 3, STEEL)
	-- Шина над банками.
	g:rect(3, 4, 26, 3, INK)
	g:rect(4, 5, 24, 1, RUST[2])
	for i = 0, 5 do
		local x = 4 + (i % 3) * 8
		local y = 8 + math.floor(i / 3) * 10
		g:rect(x, y, 7, 9, INK)
		g:rect(x + 1, y + 1, 5, 7, STEEL[2])
		g:rect(x + 1, y + 1, 1, 7, STEEL[3])
		g:rect(x + 2, y, 3, 1, tint[1])
		-- Заряд: столбик растёт и опадает, у каждой банки со своим сдвигом.
		local level = round(pulse(t, i / 6) * 5)
		if level > 0 then
			g:rect(x + 3, y + 7 - level, 2, level, teamColor(0.5 + 0.1 * level))
		end
	end
	b.bulb(g, 27, 4, pulse(t * 2))
end)
