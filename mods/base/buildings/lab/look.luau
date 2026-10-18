--!strict
-- Лаборатория, 2×2 — перенос lab из buildingArt.ts: корпус под стеклянным куполом, где висит голограмма — каркас куба,
-- и две колбы с реактивом на пристройке. В работе голограмма вращается и светится ярче, а в колбах поднимаются
-- пузыри; в простое каркас стоит тусклым, и только огонёк над входом мигает.

local b = require("lib/buildings")

local STEEL, IRON, TEAM, INK, DARK = b.STEEL, b.IRON, b.TEAM, b.INK, b.DARK
local TURN, round, pulse = b.TURN, b.round, b.pulse
local GLASS = { [0] = 0x123047, 0x1d4a6b, 0x2f6f96, 0x5aa0c8, 0xb8e2f5 }
local LIQUID = { [0] = 0x2a8f6a, 0x49d39a, 0xa8f5d0 }

return b.look(2, 2, function(g, t: number, working: boolean)
	b.slab(g, 0, 2, 32, 30, 3, STEEL)
	-- Корпус с окнами и дверью.
	b.slab(g, 2, 12, 20, 16, 4, IRON)
	b.windows(g, { 4, 17 }, 19)
	g:rect(9, 19, 6, 6, INK)
	g:rect(10, 20, 4, 5, DARK)
	b.bulb(g, 11, 16, if working then 1 else pulse(t))

	-- Стеклянный купол с голограммой.
	g:circle(12, 10, 8, INK)
	g:circle(12, 10, 7, GLASS[0])
	g:circle(11, 9, 6, GLASS[1])
	local angle = if working then t * TURN else TURN / 8
	local function corner(k: number, lift: number): (number, number)
		local a = angle + (k * TURN) / 4
		return 12 + math.cos(a) * 3.5, 11 + math.sin(a) * 1.5 - lift
	end
	for k = 0, 3 do
		local x1, y1 = corner(k, 0)
		local x2, y2 = corner(k + 1, 0)
		local x3, y3 = corner(k, 4)
		local x4, y4 = corner(k + 1, 4)
		g:line(x1, y1, x2, y2, 1, if working then TEAM[2] else TEAM[0])
		g:line(x3, y3, x4, y4, 1, if working then TEAM[2] else TEAM[0])
		g:line(x1, y1, x3, y3, 1, if working then TEAM[1] else TEAM[0])
	end
	g:light(12, 9, 3, if working then 0.7 + 0.3 * pulse(t * 2) else 0.15)
	g:rect(8, 5, 2, 1, GLASS[4])
	g:rect(7, 6, 1, 2, GLASS[3])

	-- Пристройка с колбами: реактив светится, пока идёт работа, пузыри поднимаются и замыкаются по t.
	b.slab(g, 23, 14, 8, 14, 3, IRON)
	for _, flask in { { 24, 0 }, { 28, 0.5 } } do
		local x, offset = flask[1], flask[2]
		g:rect(x, 7, 3, 9, INK)
		g:rect(x + 1, 8, 1, 7, GLASS[1])
		g:rect(x + 1, 11, 1, 4, if working then LIQUID[1] else LIQUID[0])
		if working then
			local rise = ((t * 2 + offset) % 1) * 3
			g:rect(x + 1, round(13 - rise), 1, 1, LIQUID[2])
		end
		g:rect(x, 6, 3, 1, IRON[3])
	end
	g:light(26, 12, 2, if working then 0.5 + 0.2 * pulse(t, 0.3) else 0)
end, { working = true })
