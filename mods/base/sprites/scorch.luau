--!strict
-- Гарь от взрыва: тёмная сердцевина и рваный край, который к краю редеет — пиксели гари мешаются с грунтом. Шесть
-- поперечников по три варианта; каждый — посреди кадра в 48 пикселей, фаза — номер поперечника × 3 + вариант. Кладёт её
-- на землю эффект следов боя (effects/scars).

local noise = require("lib/noise").of

local SIZES = { 8, 16, 24, 32, 40, 48 }
local VARIANTS = 3
local FRAME = 48

local function draw(g, _, phase: number)
	local size = SIZES[phase // VARIANTS + 1]
	local variant = phase % VARIANTS
	local center = size / 2
	local shift = (FRAME - size) / 2
	for y = 0, size - 1 do
		for x = 0, size - 1 do
			local dx, dy = x + 0.5 - center, y + 0.5 - center
			-- Край неровный: радиус гуляет по углу.
			local angle = math.atan2(dy, dx)
			local wobble = 0.86 + 0.07 * math.sin(angle * 3 + variant * 2.1) + 0.05 * math.sin(angle * 5 + variant * 4.3) + 0.04 * math.sin(angle * 11 + variant)
			local reach = math.sqrt(dx * dx + dy * dy) / (center * wobble)
			local grain = noise(x, y, variant + size)
			if reach > 1 or grain > (1 - reach) * 2.2 then
				continue
			end
			local color = if reach < 0.45 then (if grain < 0.3 then 0x0c0a09 else 0x15110e) elseif grain < 0.5 then 0x231b14 else 0x30251b
			g:set(x + shift, y + shift, color)
		end
	end
end

return {
	data = { sizes = SIZES, variants = VARIANTS, frame = FRAME },
	look = { size = FRAME, origin = { 0, 0 }, phases = #SIZES * VARIANTS, draw = draw },
}
