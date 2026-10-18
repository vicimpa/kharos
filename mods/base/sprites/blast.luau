--!strict
-- Взрыв — восемь кадров от вспышки до дыма: огненный шар из клубов растёт, темнеет и расходится кольцом дыма. Кадр —
-- фаза облика; рисует его эффект боя (effects/combat).

local noise = require("lib/noise").of

local FRAME = 48
local FRAMES = 8
-- Цвета взрыва по кадрам: от вспышки через огонь к дыму.
local COLORS = { [0] = 0xfff6d0, 0xffe07a, 0xffb347, 0xff7a2a, 0xd9481c, 0x8a3a24, 0x55443e, 0x3a3432 }
local CLOUDS = 7

local function draw(g, _, frame: number)
	local center = FRAME / 2
	local progress = frame / (FRAMES - 1)
	local radius = (center - 2) * (0.3 + 0.7 * math.sqrt(progress))
	-- Клубы по кругу: чем дальше взрыв, тем дальше от центра и мельче.
	local function clouds(share: number, size: number, color: number)
		for i = 0, CLOUDS - 1 do
			local angle = (i / CLOUDS) * math.pi * 2 + noise(i, 3) * 0.8
			local reach = radius * share * (0.75 + noise(i, 5) * 0.25)
			g:circle(math.round(center + math.cos(angle) * reach), math.round(center + math.sin(angle) * reach), radius * size, color)
		end
	end
	if progress < 0.6 then
		-- Огненный шар: тёмная кайма, огонь, светлая сердцевина.
		local rim = COLORS[math.min(frame + 2, FRAMES - 1)]
		g:circle(center, center, radius * 0.8, rim)
		clouds(0.6, 0.42, rim)
		g:circle(center, center, radius * 0.68, COLORS[frame + 1])
		clouds(0.45, 0.32, COLORS[frame + 1])
		g:circle(center, center, radius * 0.45, COLORS[frame])
	else
		-- Дым: клубы расходятся, середина пустеет.
		clouds(0.75, 0.34 * (1.4 - progress), COLORS[frame])
		clouds(0.55, 0.2 * (1.4 - progress), COLORS[frame - 1])
	end
end

return {
	data = { frames = FRAMES },
	look = { size = FRAME, origin = { 0, 0 }, phases = FRAMES, draw = draw },
}
