--!strict
--!native
-- Синтез звука в сэмплах: звуки игры считаются кодом, как и графика, один раз при загрузке. Запись — буфер f32 (моно)
-- или таблица буферов (стерео); значения от −1 до 1.

local dsp = {}

local exp, sin, floor, ceil, abs, min, max = math.exp, math.sin, math.floor, math.ceil, math.abs, math.min, math.max
local readf32, writef32 = buffer.readf32, buffer.writef32
local TWO_PI = 2 * math.pi

-- Генератор случайных чисел от 0 до 1 с зерном: один вариант звука всегда одинаков. Это xorshift.
function dsp.random(seed: number): () -> number
	local state = floor(seed * 2654435761) % 4294967296
	if state == 0 then
		state = 1
	end
	return function(): number
		state = bit32.bxor(state, bit32.lshift(state, 13))
		state = bit32.bxor(state, bit32.rshift(state, 17))
		state = bit32.bxor(state, bit32.lshift(state, 5))
		return state / 4294967296
	end
end

-- Фильтр нижних частот с одним полюсом: срез — число или функция, если срез меняется.
function dsp.lowpass(rate: number, cutoff: number | () -> number): (number) -> number
	local function factor(frequency: number): number
		return 1 - exp(-TWO_PI * frequency / rate)
	end
	local last = 0
	if type(cutoff) == "number" then
		local k = factor(cutoff)
		return function(input: number): number
			last += (input - last) * k
			return last
		end
	end
	local moving = cutoff :: () -> number
	return function(input: number): number
		last += (input - last) * factor(moving())
		return last
	end
end

-- Фильтр верхних частот: вход минус его низы.
function dsp.highpass(rate: number, cutoff: number): (number) -> number
	local low = dsp.lowpass(rate, cutoff)
	return function(input: number): number
		return input - low(input)
	end
end

-- Резонатор: полоса шириной frequency / q вокруг frequency, на ней усиление — единица.
function dsp.bandpass(rate: number, frequency: number, q: number): (number) -> number
	local w = TWO_PI * frequency / rate
	local alpha = math.sin(w) / (2 * q)
	local a0 = 1 + alpha
	local a1 = -2 * math.cos(w) / a0
	local a2 = (1 - alpha) / a0
	local b = alpha / a0
	local x1, x2, y1, y2 = 0, 0, 0, 0
	return function(input: number): number
		local output = b * (input - x2) - a1 * y1 - a2 * y2
		x2 = x1
		x1 = input
		y2 = y1
		y1 = output
		return output
	end
end

-- Затухание: за time секунд звук стихает в e раз. Быстрая атака за time секунд, чтобы не щёлкало начало.
function dsp.decay(t: number, time: number): number
	return exp(-t / time)
end

function dsp.attack(t: number, time: number): number
	return min(1, t / time)
end

-- Удары раз в period секунд со сдвигом offset: огибающая каждого гаснет за time.
function dsp.pulse(t: number, period: number, time: number, offset: number?): number
	local local_ = ((t - (offset or 0)) % period + period) % period
	return exp(-local_ / time)
end

local function normalize(data: buffer, length: number)
	local peak = 0
	for i = 0, length - 1 do
		peak = max(peak, abs(readf32(data, i * 4)))
	end
	if peak > 0 then
		for i = 0, length - 1 do
			writef32(data, i * 4, readf32(data, i * 4) / peak)
		end
	end
end

-- Звук длиной seconds: sample(t, noise) — значение в момент t; noise — белый шум этого варианта. Конец гаснет без
-- щелчка, пик — единица: громкость задаёт тот, кто играет.
function dsp.render(rate: number, seconds: number, variant: number, sample: (number, () -> number) -> number): buffer
	local next = dsp.random(variant + 1)
	local function noise(): number
		return next() * 2 - 1
	end
	local length = ceil(rate * seconds)
	local data = buffer.create(length * 4)
	for i = 0, length - 1 do
		writef32(data, i * 4, sample(i / rate, noise))
	end
	local tail = min(length, math.round(rate * 0.01))
	for i = 0, tail - 1 do
		local at = (length - 1 - i) * 4
		writef32(data, at, readf32(data, at) * i / tail)
	end
	normalize(data, length)
	return data
end

-- Петля длиной seconds: как render, но конец плавно переходит в начало без щелчка на стыке.
function dsp.loop(rate: number, seconds: number, sample: (number, () -> number) -> number): buffer
	local fade = math.round(rate * 0.25)
	local length = ceil(rate * seconds)
	local next = dsp.random(7)
	local function noise(): number
		return next() * 2 - 1
	end
	local raw = buffer.create((length + fade) * 4)
	for i = 0, length + fade - 1 do
		writef32(raw, i * 4, sample(i / rate, noise))
	end
	local data = buffer.create(length * 4)
	buffer.copy(data, 0, raw, 0, length * 4)
	for i = 0, fade - 1 do
		local k = i / fade
		writef32(data, i * 4, readf32(data, i * 4) * k + readf32(raw, (length + i) * 4) * (1 - k))
	end
	normalize(data, length)
	return data
end

-- Средняя громкость петли шума: громкость слоя задаёт тот, кто её играет.
dsp.NOISE_LEVEL = 0.25

-- Петля шума длиной seconds без шва: белый — шипение, розовый — ровный шелест, бурый — глухой гул.
function dsp.noiseLoop(rate: number, seconds: number, seed: number, color: string): buffer
	local next = dsp.random(seed)
	local length = ceil(rate * seconds)
	local fade = min(length, math.round(rate * 0.25))
	local raw = buffer.create((length + fade) * 4)
	local pink0, pink1, pink2, brown = 0, 0, 0, 0
	for i = 0, length + fade - 1 do
		local white = next() * 2 - 1
		local value
		if color == "white" then
			value = white
		elseif color == "pink" then
			pink0 = 0.99765 * pink0 + white * 0.099046
			pink1 = 0.963 * pink1 + white * 0.2965164
			pink2 = 0.57 * pink2 + white * 1.0526913
			value = pink0 + pink1 + pink2 + white * 0.1848
		else
			brown = (brown + white * 0.02) / 1.02
			value = brown
		end
		writef32(raw, i * 4, value)
	end
	-- Шов: начало петли — её продолжение за концом, которое плавно уступает собственному началу.
	local data = buffer.create(length * 4)
	buffer.copy(data, 0, raw, 0, length * 4)
	for i = 0, fade - 1 do
		local k = i / fade * math.pi / 2
		writef32(data, i * 4, readf32(raw, i * 4) * sin(k) + readf32(raw, (length + i) * 4) * math.cos(k))
	end
	local mean = 0
	for i = 0, length - 1 do
		mean += readf32(data, i * 4) / length
	end
	local energy = 0
	for i = 0, length - 1 do
		local value = readf32(data, i * 4) - mean
		writef32(data, i * 4, value)
		energy += value * value
	end
	local rms = math.sqrt(energy / length)
	local scale = dsp.NOISE_LEVEL / (if rms > 0 then rms else 1)
	for i = 0, length - 1 do
		writef32(data, i * 4, readf32(data, i * 4) * scale)
	end
	return data
end

-- Отклик для эха: стерео шум, гаснущий за seconds в тысячу раз и темнеющий к хвосту — пустой простор.
function dsp.reverbImpulse(rate: number, seconds: number, seed: number): { buffer }
	local channels = {}
	for channel = 0, 1 do
		local next = dsp.random(seed * 2 + channel + 1)
		local t = 0
		local tone = dsp.lowpass(rate, function()
			return 500 + 6000 * exp(-t / (seconds * 0.2))
		end)
		local length = ceil(rate * seconds)
		local data = buffer.create(length * 4)
		-- Первое отражение приходит не сразу: стены далеко.
		local delay = 0.02
		for i = 0, length - 1 do
			t = i / rate
			local sample = tone(next() * 2 - 1)
			writef32(data, i * 4, if t < delay then 0 else sample * exp(-6.9 * (t - delay) / seconds))
		end
		normalize(data, length)
		table.insert(channels, data)
	end
	return channels
end

-- Плавное число от 0 до 1, которое бродит: за единицу аргумента — шаг к новому случайному значению (wanderer).
function dsp.wanderer(seed: number): (number) -> number
	local function value(step: number): number
		return dsp.random(seed * 7919 + step + 1)()
	end
	return function(t: number): number
		local step = floor(t)
		local f = t - step
		local a = value(step)
		return a + (value(step + 1) - a) * f * f * (3 - 2 * f)
	end
end

-- Знак, как Math.sign.
function dsp.sign(value: number): number
	return if value > 0 then 1 elseif value < 0 then -1 else 0
end

return dsp
