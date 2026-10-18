--!strict
-- Цех компонентов, 2×2: чистая комната с зелёной платой, над которой ездит манипулятор и ставит микросхемы.

local b = require("lib/buildings")

local INK = b.INK
local TURN, round, pulse, chase = b.TURN, b.round, b.pulse, b.chase
local WHITE = { [0] = 0x6d7680, 0x9aa4ae, 0xc3cbd3, 0xe1e7ec, 0xffffff }
local PCB = { [0] = 0x0d3a22, 0x16603a, 0x2a8c55 }

return b.look(2, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.goodColor("parts"))
	b.slab(g, 0, 2, 32, 30, 3, WHITE)

	-- Плата: зелёное поле с дорожками и микросхемами.
	g:rect(3, 5, 26, 18, INK)
	g:rect(4, 6, 24, 16, PCB[1])
	for y = 8, 20, 4 do
		g:rect(5, y, 22, 1, PCB[2])
	end
	for x = 9, 26, 6 do
		g:rect(x, 7, 1, 14, PCB[0])
	end
	for _, at in { { 6, 9 }, { 14, 9 }, { 22, 9 }, { 6, 16 }, { 14, 16 } } do
		g:rect(at[1], at[2], 4, 3, INK)
		g:rect(at[1], at[2], 4, 1, 0x30363c)
	end
	-- Светодиоды платы: в работе бегут, в простое тихо.
	for i = 0, 2 do
		b.bulb(g, 22 + (i % 2) * 3, 15 + i * 2, if working then chase(t, i / 3) else 0)
	end

	-- Портал манипулятора: рельс поперёк, каретка ездит туда-сюда и опускает головку.
	local along = if working then 0.5 - 0.5 * math.cos(TURN * t) else 0
	local hx = round(6 + along * 18)
	g:rect(3, 12, 26, 2, INK)
	g:rect(3, 12, 26, 1, WHITE[3])
	g:rect(hx - 2, 10, 5, 6, INK)
	g:rect(hx - 1, 11, 3, 4, WHITE[2])
	g:rect(hx, 12, 1, 2, if working and along > 0.45 and along < 0.55 then tint[2] else tint[0])

	-- Готовые компоненты в лотке внизу.
	g:rect(3, 23, 26, 5, INK)
	g:rect(4, 24, 24, 3, WHITE[1])
	for x = 5, 26, 4 do
		g:rect(x, 24, 3, 2, tint[0])
		g:rect(x, 24, 3, 1, tint[1])
	end
	b.lamp(g, 29, 4, 1, pulse(t))
end, { working = true })
