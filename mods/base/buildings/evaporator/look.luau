--!strict
-- Выпарка лития, 3×2 — перенос evaporator из buildingArt.ts: два мелких пруда розового рассола, в работе по ним бегут
-- блики; насосная с трубой к прудам и куча соли, которую подгребает скребок.

local b = require("lib/buildings")

local IRON, INK, HAZARD = b.IRON, b.INK, b.HAZARD
local round, pulse = b.round, b.pulse
local SALT = { [0] = 0x7a7068, 0xa89e94, 0xd0c8be, 0xe8e2da, 0xffffff }

return b.look(3, 2, function(g, t: number, working: boolean)
	local tint = b.accent(b.goodColor("lithium"))
	b.slab(g, 0, 2, 48, 30, 3, SALT)
	-- Пруды: обваловка, рассол и блики, которые в работе плывут.
	for _, pond in { { 3, 5, 0 }, { 3, 16, 0.5 } } do
		local x, y, offset = pond[1], pond[2], pond[3]
		g:rect(x, y, 26, 10, INK)
		g:rect(x + 1, y + 1, 24, 8, SALT[0])
		g:rect(x + 2, y + 2, 22, 6, tint[0])
		g:rect(x + 2, y + 2, 22, 2, tint[1])
		for i = 0, 2 do
			local shift = if working then math.floor(((t + offset + i / 3) % 1) * 18) else i * 6
			g:rect(x + 3 + shift, y + 4 + (i % 2), 3, 1, tint[2])
		end
	end
	-- Насосная: короб с трубой к прудам, лампа насоса мигает в такт.
	g:rect(31, 5, 13, 11, INK)
	g:rect(32, 6, 11, 9, IRON[2])
	g:rect(32, 6, 11, 1, IRON[3])
	g:rect(29, 9, 3, 2, IRON[1])
	g:rect(29, 20, 3, 2, IRON[1])
	g:rect(30, 9, 1, 13, IRON[1])
	b.lamp(g, 40, 10, 2, if working then pulse(t * 4) else 0.2)
	-- Куча соли и скребок, который её подгребает.
	g:circle(38, 23, 5, INK)
	g:circle(38, 23, 4, SALT[3])
	g:circle(37, 22, 2, SALT[4])
	g:rect(37, 20, 2, 1, tint[2])
	local reach = if working then round(pulse(t) * 3) else 0
	g:rect(31 + reach, 27, 4, 2, INK)
	g:rect(31 + reach, 27, 3, 1, HAZARD[1])
end, { working = true })
