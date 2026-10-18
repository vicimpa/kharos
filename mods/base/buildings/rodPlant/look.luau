--!strict
-- Завод стержней, 2×2 — перенос rodPlant из buildingArt.ts: пресс набивает таблетки урана в трубки, трубки лежат в
-- кассете; зелёный огонёк на прессе в работе мигает с каждым ходом, лампа радиации — по краю.

local b = require("lib/buildings")

local IRON, INK, HAZARD = b.IRON, b.INK, b.HAZARD
local round, pulse, chase = b.round, b.pulse, b.chase

return b.look(2, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.GOOD_COLORS.rods)
	b.slab(g, 0, 2, 32, 30, 3, IRON)
	for x = 2, 29, 4 do
		g:rect(x, 4, 2, 2, HAZARD[1])
		g:rect(x + 2, 4, 2, 2, HAZARD[0])
	end
	-- Пресс: станина и шток, который в работе ходит вниз-вверх.
	g:rect(4, 8, 11, 14, INK)
	g:rect(5, 9, 9, 12, IRON[2])
	g:rect(5, 9, 9, 1, IRON[3])
	local stroke = if working then round(pulse(t * 2) * 4) else 0
	g:rect(8, 10, 3, 5 + stroke, INK)
	g:rect(9, 10, 1, 5 + stroke, IRON[4])
	b.bulb(g, 11, 18, if working then pulse(t * 2) else 0.15)
	-- Кассета: трубки со стержнями, в работе по одной загорается торец.
	g:rect(17, 8, 12, 19, INK)
	g:rect(18, 9, 10, 17, IRON[1])
	for i = 0, 3 do
		local x = 19 + i * 2
		g:rect(x, 10, 1, 15, IRON[3])
		g:rect(x, 10, 1, 1, if working and chase(t, i / 4) > 0.3 then tint[2] else tint[0])
	end
	g:rect(4, 24, 11, 3, IRON[1])
	b.lamp(g, 27, 28, 1, pulse(t))
end, { working = true })
