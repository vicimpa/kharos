--!strict
-- Цвета 0xRRGGBB: из долей каналов, сдвиг к белому или чёрному, три тона для окраски.

local color = {}

-- Цвет из долей каналов от 0 до 1.
function color.rgb(r: number, g: number, b: number): number
	return math.round(r * 255) * 0x10000 + math.round(g * 255) * 0x100 + math.round(b * 255)
end

-- Цвет, сдвинутый к белому (amount > 0) или к чёрному (amount < 0).
function color.shade(value: number, amount: number): number
	local function channel(shift: number): number
		local level = bit32.band(bit32.rshift(value, shift), 255)
		return math.floor((if amount > 0 then level + (255 - level) * amount else level * (1 + amount)) + 0.5)
	end
	return channel(16) * 0x10000 + channel(8) * 0x100 + channel(0)
end

-- Три тона цвета: тёмный, основной, светлый — для окраски частей здания цветом его груза.
function color.accent(value: number): { [number]: number }
	return { [0] = color.shade(value, -0.55), color.shade(value, -0.15), color.shade(value, 0.3) }
end

return color
