--!strict
-- Урановая фабрика, 2×2 — перенос uraniumMill из buildingArt.ts: бак выщелачивания с мешалкой и зелёным раствором,
-- рядом линия бочек с жёлтым кеком; полосы опасности по краю и лампа радиации.

local b = require("lib/buildings")

local IRON, INK, HAZARD = b.IRON, b.INK, b.HAZARD
local TURN, pulse, chase = b.TURN, b.pulse, b.chase

return b.look(2, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.goodColor("uranium"))
	b.slab(g, 0, 2, 32, 30, 3, IRON)
	for x = 2, 29, 4 do
		g:rect(x, 4, 2, 2, HAZARD[1])
		g:rect(x + 2, 4, 2, 2, HAZARD[0])
	end
	-- Бак: раствор светится, мешалка крутится в работе.
	local cx, cy = 12, 16
	g:circle(cx, cy, 9, INK)
	g:circle(cx, cy, 8, IRON[3])
	g:circle(cx, cy, 6, INK)
	g:circle(cx, cy, 5, if working then tint[1] else tint[0])
	local angle = TURN * (if working then t else 0.1)
	g:line(cx - math.cos(angle) * 4, cy - math.sin(angle) * 4, cx + math.cos(angle) * 4, cy + math.sin(angle) * 4, 1, IRON[4])
	g:circle(cx, cy, 1.5, IRON[4])
	g:light(cx, cy, 5, if working then 0.4 + 0.3 * pulse(t * 2) else 0.1)
	-- Бочки с кеком: в работе по одной загорается крышка — бочка наполнена.
	for i = 0, 2 do
		local y = 9 + i * 6
		g:rect(23, y, 6, 5, INK)
		g:rect(24, y + 1, 4, 3, HAZARD[1])
		g:rect(24, y + 1, 4, 1, if working and chase(t, i / 3) > 0.3 then tint[2] else 0xf0d860)
	end
	b.lamp(g, 27, 27, 2, pulse(t * (if working then 3 else 1)))
end, { working = true })
