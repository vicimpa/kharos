--!strict
-- Ракетная шахта, 3×3 — перенос silo из buildingArt.ts: бетонная плита в полосах опасности, посередине — ствол под
-- двумя створками, слева — пульт. Вариант — ступень пуска: сначала створки расходятся (до DOOR_STEPS − 1), потом в
-- открытом стволе поднимается ракета — сверху её нос растёт и светлеет. working — боеголовка готова: лампа пульта
-- зелёная, у пустой — жёлтая.

local b = require("lib/buildings")

local STEEL, IRON, INK, DARK, HAZARD, FIRE = b.STEEL, b.IRON, b.INK, b.DARK, b.HAZARD, b.FIRE
local round, pulse, chase = b.round, b.pulse, b.chase
local CONCRETE = { [0] = 0x4f4c47, 0x77736b, 0x9d988e, 0xbfb9ae, 0xe0dbd1 }
-- Ступеней открытия створок и подъёма ракеты в открытом стволе (SILO_DOOR_STEPS, SILO_RISE_STEPS).
local DOOR_STEPS, RISE_STEPS = 8, 4

return b.look(3, 3, function(g, t: number, working: boolean, variant: number)
	local open = math.min(1, variant / (DOOR_STEPS - 1))
	local rise = math.max(0, variant - (DOOR_STEPS - 1)) / RISE_STEPS
	b.slab(g, 0, 2, 48, 46, 4, CONCRETE)
	for x = 2, 45, 4 do
		g:rect(x, 4, 2, 2, HAZARD[1])
		g:rect(x + 2, 4, 2, 2, HAZARD[0])
	end
	-- Ствол: тёмный колодец с ребрами по стенкам.
	local left, top, size = 16, 11, 22
	g:rect(left - 2, top - 2, size + 4, size + 4, INK)
	g:rect(left, top, size, size, DARK)
	for i = 2, size - 1, 5 do
		g:rect(left + i, top, 1, size, IRON[0])
	end
	-- Ракета в стволе: нос сверху — круг с красной макушкой; поднимаясь, он ближе и крупнее.
	if open > 0.5 then
		local radius = 4 + rise * 3
		local cx, cy = left + size / 2, top + size / 2
		g:circle(cx, cy, radius + 1, INK)
		g:circle(cx, cy, radius, IRON[3])
		g:circle(cx - radius * 0.25, cy - radius * 0.25, radius * 0.6, IRON[4])
		g:circle(cx, cy, math.max(1, radius * 0.3), FIRE[1])
	end
	-- Створки уходят под бетон в стороны.
	local shift = round(open * (size / 2))
	local function door(x: number, w: number)
		if w <= 0 then
			return
		end
		g:rect(x, top, w, size, STEEL[1])
		g:rect(x, top, w, 1, STEEL[3])
		local y = top + 3
		while y < top + size do
			g:rect(x, y, w, 2, HAZARD[1])
			y += 6
		end
	end
	door(left, size / 2 - shift)
	door(left + size / 2 + shift, size / 2 - shift)
	if shift == 0 then
		g:rect(left + size / 2, top, 1, size, INK)
	end
	-- Рама ствола поверх створок.
	g:rect(left - 2, top - 2, size + 4, 2, CONCRETE[2])
	g:rect(left - 2, top + size, size + 4, 2, CONCRETE[0])
	g:rect(left - 2, top, 2, size, CONCRETE[2])
	g:rect(left + size, top, 2, size, CONCRETE[0])
	-- Пульт слева: будка с окном и лампой готовности.
	b.slab(g, 2, 14, 11, 16, 4, IRON)
	b.windows(g, { 4, 8 }, 18)
	local ready = if working then 0x5fe08a else 0xe0b84a
	g:rect(6, 24, 3, 3, INK)
	g:rect(7, 25, 1, 1, ready)
	g:light(7.5, 25.5, 1.5, if working then 0.6 else 0.25 + 0.2 * pulse(t))
	-- Огни по углам ствола: в пуске бегут по кругу.
	local corners = { { left - 3, top - 3 }, { left + size + 1, top - 3 }, { left + size + 1, top + size + 1 }, { left - 3, top + size + 1 } }
	for i, at in corners do
		b.bulb(g, at[1], at[2], if open > 0 then chase(t * 2, (i - 1) / 4) else 0.1)
	end
	b.lamp(g, 42, 40, 2, pulse(t))
end, { working = true, variants = DOOR_STEPS + RISE_STEPS })
