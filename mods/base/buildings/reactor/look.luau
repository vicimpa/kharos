--!strict
-- Реактор, 3×3 — перенос reactor из buildingArt.ts: герметичный купол над активной зоной, градирня с паром и щит с
-- полосами опасности. Пока горит стержень, из окна купола идёт синее свечение, огни по кольцу бегут, а градирня парит.

local b = require("lib/buildings")

local STEEL, RUST, INK, HAZARD = b.STEEL, b.RUST, b.INK, b.HAZARD
local TURN, round, pulse, chase = b.TURN, b.round, b.pulse, b.chase
local CONCRETE = { [0] = 0x5a5650, 0x837e76, 0xa8a299, 0xc8c2b8, 0xe6e1d8 }
local GLOW = { [0] = 0x1a3a8a, 0x3f8cff, 0xbfe4ff }

return b.look(3, 3, function(g, t: number, working: boolean)
	b.slab(g, 0, 2, 48, 46, 4, CONCRETE)
	for x = 2, 45, 4 do
		g:rect(x, 42, 2, 2, HAZARD[1])
		g:rect(x + 2, 42, 2, 2, HAZARD[0])
	end
	-- Градирня справа: широкое основание, сужение и пар над ней.
	b.tower(g, 36, 26, 8, 10, CONCRETE)
	g:circle(36, 16, 6, INK)
	g:circle(36, 16, 5, CONCRETE[0])
	if working then
		for i = 0, 2 do
			local rise = ((t + i / 3) % 1) * 10
			g:circle(36 + (i - 1) * 2, 14 - rise, 3 + rise * 0.3, if i % 2 ~= 0 then 0xdfe6ea else 0xf4f7f9)
		end
	end
	-- Купол над активной зоной слева: окно со свечением и кольцо огней.
	b.tower(g, 16, 26, 12, 4, STEEL)
	local level = if working then 0.6 + 0.4 * pulse(t * 2) else 0.1
	g:rect(13, 18, 7, 5, INK)
	g:rect(14, 19, 5, 3, if working then GLOW[1] else GLOW[0])
	if working then
		g:rect(15, 20, 3, 1, GLOW[2])
	end
	g:light(16, 20, 6, level * 0.8)
	local LIGHTS = 8
	for i = 0, LIGHTS - 1 do
		local angle = (i / LIGHTS) * TURN
		local x = round(16 + math.cos(angle) * 9)
		local y = round(22 + math.sin(angle) * 9)
		b.bulb(g, x - 1, y - 1, if working then chase(t, i / LIGHTS) else 0.1)
	end
	-- Трубы от купола к градирне.
	g:rect(27, 30, 4, 3, INK)
	g:rect(27, 31, 4, 1, RUST[1])
	b.lamp(g, 6, 38, 2, pulse(t * (if working then 2 else 1)))
end, { working = true })
