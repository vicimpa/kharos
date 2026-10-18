--!strict
-- Простое воспроизводимое случайное число от 0 до 1 по целым (noise в combatPass.ts и decalsPass.ts).

local noise = {}

function noise.of(a: number, b: number, c: number?): number
	local value = math.sin(a * 127.1 + b * 311.7 + (c or 0) * 74.7) * 43758.5453
	return value - math.floor(value)
end

return noise
