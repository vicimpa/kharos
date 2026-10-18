--!strict
-- Обогатитель харита, 2×2 — перенос enricher из buildingArt.ts: круглая центрифуга во всю площадку за полосами
-- опасности, в центре — светящееся ядро.

local b = require("lib/buildings")

local IRON, INK, HAZARD = b.IRON, b.INK, b.HAZARD
local TURN, round, pulse = b.TURN, b.round, b.pulse

return b.look(2, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.goodColor("kharite"))
	b.slab(g, 0, 2, 32, 30, 3, IRON)
	for x = 2, 29, 4 do
		g:rect(x, 4, 2, 2, HAZARD[1])
		g:rect(x + 2, 4, 2, 2, HAZARD[0])
	end

	-- Центрифуга: в работе капсулы бегут по кольцу, в простое стоят.
	local cx, cy = 16, 16
	g:circle(cx, cy, 11, INK)
	g:circle(cx, cy, 10, IRON[2])
	g:circle(cx, cy, 7, INK)
	g:circle(cx, cy, 6, IRON[0])
	for i = 0, 3 do
		local angle = TURN * ((if working then t else 0.125) + i / 4)
		local x = cx + math.cos(angle) * 8.5
		local y = cy + math.sin(angle) * 8.5
		g:line(cx, cy, x, y, 1, IRON[3])
		g:circle(x, y, 2, if working then tint[1] else tint[0])
		g:rect(round(x) - 1, round(y) - 1, 1, 1, tint[2])
	end
	-- Ядро: в работе дышит светом харита, в простое едва теплится.
	local core = if working then 0.6 + 0.4 * pulse(t * 2) else 0.15
	g:circle(cx, cy, 4, tint[0])
	g:circle(cx, cy, 3, if core > 0.85 then tint[2] elseif working then tint[1] else tint[0])
	g:light(cx, cy, 5, core)
	b.lamp(g, 28, 26, 2, pulse(t * (if working then 3 else 1)))
end, { working = true })
