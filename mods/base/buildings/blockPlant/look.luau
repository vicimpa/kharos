--!strict
-- Цех стройблоков, 2×2 — перенос blockPlant из buildingArt.ts: бетономешалка с лопастями, формовочный стол, где блок
-- выдавливается из формы, и паллеты кладки.

local b = require("lib/buildings")

local IRON, RUST, INK = b.IRON, b.RUST, b.INK
local TURN, FRAMES, pulse, chase = b.TURN, b.FRAMES, b.pulse, b.chase
local CONCRETE = { [0] = 0x4a4844, 0x6e6a63, 0x8f8a80, 0xb1aba0, 0xd4cfc4 }

return b.look(2, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.GOOD_COLORS.blocks)
	b.slab(g, 0, 2, 32, 30, 3, CONCRETE)

	-- Мешалка: барабан с лопастями, в работе они крутятся в сером растворе.
	local cx, cy = 10, 11
	g:circle(cx, cy, 8, INK)
	g:circle(cx, cy, 7, RUST[1])
	g:circle(cx, cy, 5, INK)
	g:circle(cx, cy, 4, CONCRETE[1])
	for i = 0, 2 do
		local angle = TURN * ((if working then t else 0) + i / 3)
		g:line(cx, cy, cx + math.cos(angle) * 4, cy + math.sin(angle) * 4, 1, CONCRETE[3])
	end
	g:rect(cx, cy, 1, 1, INK)

	-- Формовочный стол под мешалкой: блок выдавливается из формы и уезжает вправо.
	g:rect(2, 21, 16, 7, INK)
	g:rect(3, 22, 14, 5, IRON[1])
	g:rect(3, 22, 4, 5, IRON[0])
	local slide = if working then math.floor(t * FRAMES) % 8 else 0
	if working then
		g:rect(4 + slide, 23, 4, 3, INK)
		g:rect(5 + slide, 23, 3, 2, tint[1])
		g:rect(5 + slide, 23, 3, 1, tint[2])
	end

	-- Паллеты стройблоков: кладка вперевязку.
	for _, at in { { 20, 5 }, { 20, 17 } } do
		local x, y = at[1], at[2]
		g:rect(x, y, 10, 9, INK)
		for row = 0, 2 do
			local offset = if row % 2 ~= 0 then 2 else 0
			for col = -1, 2 do
				local bx = x + 1 + offset + col * 4
				local left = math.max(bx, x + 1)
				local right = math.min(bx + 3, x + 9)
				if right <= left then
					continue
				end
				g:rect(left, y + 1 + row * 3, right - left, 2, tint[1])
				g:rect(left, y + 1 + row * 3, right - left, 1, tint[2])
			end
		end
	end
	b.lamp(g, 18, 3, 1, pulse(t))
	b.bulb(g, 15, 18, if working then chase(t, 0) else 0)
end, { working = true })
