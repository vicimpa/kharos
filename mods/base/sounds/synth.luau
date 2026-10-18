--!strict
--!native
-- Звуки боя, интерфейса, фоновые петли и звуки дали. Каждый — функция (rate, variant) → сэмплы; variant меняет зерно
-- шума: варианты одного звука не звучат одинаково.

local dsp = require("lib/dsp")

local random, lowpass, highpass, bandpass, render, loop = dsp.random, dsp.lowpass, dsp.highpass, dsp.bandpass, dsp.render, dsp.loop
local decay, attack, pulse, sign = dsp.decay, dsp.attack, dsp.pulse, dsp.sign
local sin, cos, floor, exp, abs, pow = math.sin, math.cos, math.floor, math.exp, math.abs, math.pow
local PI = math.pi

-- Вариантов у каждого разового звука.
local VARIANTS = 3

-- Винтовка: сухой щелчок и короткий хлопок.
local function rifle(rate: number, variant: number)
	local crack = highpass(rate, 2500)
	local body = lowpass(rate, function()
		return 900
	end)
	return render(rate, 0.2, variant, function(t, noise)
		local n = noise()
		return crack(n) * decay(t, 0.01) * 0.9 + body(n) * decay(t, 0.05) * 1.6 + sin(2 * PI * 140 * t) * decay(t, 0.025) * 0.35
	end)
end

-- Пулемёт: щелчок короче и легче винтовочного, чтобы очередь не сливалась в гул.
local function machinegun(rate: number, variant: number)
	local crack = highpass(rate, 3000)
	local body = lowpass(rate, function()
		return 1400
	end)
	return render(rate, 0.12, variant, function(t, noise)
		local n = noise()
		return crack(n) * decay(t, 0.007) * 0.7 + body(n) * decay(t, 0.03) * 1.2 + sin(2 * PI * 180 * t) * decay(t, 0.015) * 0.25
	end)
end

-- Пушка: удар, глухой бас, уходящий вниз, и раскат.
local function cannon(rate: number, variant: number)
	local crack = highpass(rate, 1500)
	local rumble = lowpass(rate, function()
		return 320
	end)
	local phase = 0
	return render(rate, 1.3, variant, function(t, noise)
		local n = noise()
		phase += 2 * PI * (40 + 60 * decay(t, 0.12)) / rate
		return crack(n) * decay(t, 0.012) * 0.8 + sin(phase) * decay(t, 0.3) * 0.8 + rumble(n) * decay(t, 0.4) * 2.4
	end)
end

-- Ракета: хлопок пуска и шипение уходящего двигателя.
local function launcher(rate: number, variant: number)
	local hiss = highpass(rate, 500)
	local t = 0
	-- Шипение темнеет: ракета уходит.
	local band = lowpass(rate, function()
		return 1200 + 3000 * decay(t, 0.15)
	end)
	local pop = lowpass(rate, function()
		return 600
	end)
	return render(rate, 0.7, variant, function(time, noise)
		t = time
		local n = noise()
		local whoosh = band(hiss(n)) * attack(t, 0.03) * decay(t, 0.25) * 1.4
		return whoosh + pop(n) * decay(t, 0.03) * 1.5
	end)
end

-- Лазер: тон, падающий сверху вниз, с лёгким дребезгом.
local function laser(rate: number, variant: number)
	local phase = variant * 0.7
	return render(rate, 0.35, variant, function(t)
		local frequency = 500 + 1800 * decay(t, 0.06) + sin(2 * PI * 30 * t) * 25
		phase += 2 * PI * frequency / rate
		local tone = sin(phase) * 0.7 + sign(sin(phase)) * 0.15
		return tone * attack(t, 0.004) * decay(t, 0.1) * 0.6
	end)
end

-- Разряд: треск — шум, который рвётся на вспышки, поверх гудения.
local function arc(rate: number, variant: number)
	local next = random(variant + 101)
	local crackle = highpass(rate, 1200)
	local gate, untilAt = 0, 0
	return render(rate, 0.5, variant, function(t, noise)
		if t >= untilAt then
			gate = if next() < 0.55 then 0.4 + next() * 0.6 else 0
			untilAt = t + 0.003 + next() * 0.012
		end
		local buzz = ((t * 110) % 1) * 2 - 1
		return crackle(noise()) * gate * decay(t, 0.18) * 1.1 + buzz * decay(t, 0.12) * 0.18
	end)
end

-- Взрыв: удар и раскатистый шум, который глохнет, темнея. big — громадный: дольше и ниже.
local function explosion(rate: number, variant: number, big: boolean)
	local length = if big then 1.9 else 0.9
	local fade = if big then 0.5 else 0.22
	local t = 0
	local body = lowpass(rate, function()
		return 160 + 2200 * decay(t, if big then 0.18 else 0.1)
	end)
	local phase = 0
	return render(rate, length, variant, function(time, noise)
		t = time
		phase += 2 * PI * (if big then 38 else 60) * (1 + decay(time, 0.08)) / rate
		local thump = sin(phase) * decay(time, if big then 0.25 else 0.12) * (if big then 0.9 else 0.6)
		return body(noise()) * attack(time, 0.004) * decay(time, fade) * 2.6 + thump
	end)
end

-- Сигнал: тоны по очереди, каждый — tone секунд с паузой gap; квадратная примесь делает его слышным в бою.
local function signal(rate: number, variant: number, tones: { number }, tone: number, gap: number)
	local phase = 0
	return render(rate, #tones * (tone + gap), variant, function(t)
		local index = floor(t / (tone + gap))
		local localT = t - index * (tone + gap)
		if index >= #tones or localT > tone then
			return 0
		end
		-- Варианты чуть разнятся высотой: один и тот же сигнал подряд не звучит как запись.
		phase += 2 * PI * tones[index + 1] * (1 + variant * 0.012) / rate
		local wave = sin(phase) * 0.8 + sign(sin(phase)) * 0.2
		return wave * attack(localT, 0.005) * math.min(1, (tone - localT) / 0.02)
	end)
end

-- Короткий тон интерфейса: частота скользит от from к to за length секунд, click — щелчок в начале.
local function blip(rate: number, variant: number, from: number, to: number, length: number, click: number?)
	local phase = 0
	local tick = highpass(rate, 3000)
	local clicked = click or 0
	return render(rate, length, variant, function(t, noise)
		local frequency = from + (to - from) * math.min(1, t / length)
		phase += 2 * PI * frequency * (1 + variant * 0.01) / rate
		local tone = (sin(phase) * 0.85 + sign(sin(phase)) * 0.15) * attack(t, 0.003) * decay(t, length / 3)
		return tone + tick(noise()) * decay(t, 0.004) * clicked
	end)
end

-- Гул электростанции: сеть и её гармоники, чуть дышащие.
local function hum(rate: number)
	local air = lowpass(rate, function()
		return 400
	end)
	return loop(rate, 4, function(t, noise)
		local breath = 1 + sin(2 * PI * 0.5 * t) * 0.15
		return (sin(2 * PI * 50 * t) * 0.6 + sin(2 * PI * 100 * t) * 0.35 + sin(2 * PI * 150 * t) * 0.12) * breath + air(noise()) * 0.25
	end)
end

-- Цех и переработка: мерный стук пресса и звон металла поверх шипения.
local function machinery(rate: number)
	local thud = lowpass(rate, function()
		return 300
	end)
	local hiss = highpass(rate, 2500)
	return loop(rate, 2, function(t, noise)
		local n = noise()
		local press = thud(n) * pulse(t, 0.5, 0.06) * 2.2
		local ring = sin(2 * PI * 760 * t) * pulse(t, 1, 0.12, 0.25) * 0.35
		return press + ring + hiss(n) * 0.08 + sin(2 * PI * 60 * t) * 0.15
	end)
end

-- Шахта: бур — жужжание, которое дрожит.
local function drill(rate: number)
	local grit = lowpass(rate, function()
		return 900
	end)
	return loop(rate, 2, function(t, noise)
		local wobble = 1 + sin(2 * PI * 7 * t) * 0.3
		local buzz = (((t * 95) % 1) * 2 - 1) * 0.4
		return (buzz + grit(noise()) * 1.4) * wobble
	end)
end

-- Пехота: шаги вразнобой — глухие шорохи.
local function steps(rate: number)
	local scuff = lowpass(rate, function()
		return 1200
	end)
	return loop(rate, 2, function(t, noise)
		local n = noise()
		local beat = pulse(t, 0.5, 0.03) + pulse(t, 0.5, 0.03, 0.23) * 0.8 + pulse(t, 0.66, 0.025, 0.1) * 0.6
		return scuff(n) * beat * 2
	end)
end

-- Скрип ржавого металла: срывы трения, то чаще, то реже, раскачивают звонкие резонансы.
local function creak(rate: number, variant: number)
	local next = random(variant + 301)
	local length = 1.6 + next() * 1.2
	local base = 34 + next() * 26
	local sway = next() * PI * 2
	local bodies = { bandpass(rate, 480 + next() * 200, 14), bandpass(rate, 1100 + next() * 300, 18), bandpass(rate, 2200 + next() * 500, 24) }
	local weights = { 1, 0.7, 0.35 }
	local phase = 0
	return render(rate, length, variant, function(t, noise)
		-- Металл тянет: срывы то учащаются, то редеют.
		local frequency = base * (1 + 0.4 * sin(2 * PI * 0.5 * t + sway) + 0.15 * sin(2 * PI * 1.7 * t + sway * 2))
		phase += frequency / rate
		local slip = 0
		if phase >= 1 then
			phase -= 1
			slip = 0.6 + 0.4 * abs(noise())
		end
		local swell = pow(sin(PI * math.min(1, t / length)), 0.7)
		local input = (slip + noise() * 0.02) * swell
		local output = 0
		for i = 1, #bodies do
			output += bodies[i](input) * weights[i]
		end
		return output
	end)
end

-- Лязг: где-то упал или стукнул на ветру лист железа. Неровные обертоны с биением, долго гаснут.
local function clank(rate: number, variant: number)
	local next = random(variant + 401)
	local base = 140 + next() * 160
	-- Отношение к основному тону, за сколько секунд гаснет и насколько громок.
	local partials = { { 1, 1.8, 1 }, { 2.32, 1.1, 0.6 }, { 3.89, 0.7, 0.45 }, { 5.61, 0.45, 0.3 }, { 7.13, 0.3, 0.2 } }
	-- Две близкие частоты на обертон — металл дрожит. Синус — точка, что вращается по кругу.
	local tones = {}
	for _, partial in partials do
		for _, detune in { 1, 1.004 } do
			local step = 2 * PI * base * partial[1] * detune / rate
			table.insert(tones, { cos = cos(step), sin = sin(step), x = 1, y = 0, level = partial[3], fade = exp(-1 / (partial[2] * rate)) })
		end
	end
	local click = lowpass(rate, 2500)
	return render(rate, 3, variant, function(t, noise)
		local output = 0
		for _, tone in tones do
			local x = tone.x * tone.cos - tone.y * tone.sin
			tone.y = tone.x * tone.sin + tone.y * tone.cos
			tone.x = x
			output += tone.y * tone.level
			tone.level *= tone.fade
		end
		return output * attack(t, 0.002) + click(noise()) * decay(t, 0.008) * 2
	end)
end

-- Далёкий гром: раскаты низкого шума, один за другим, всё тише.
local function thunder(rate: number, variant: number)
	local next = random(variant + 501)
	local rumble = lowpass(rate, 150)
	local deeper = lowpass(rate, 150)
	local rolls = {}
	for i = 0, 3 do
		table.insert(rolls, {
			at = if i == 0 then 0 else i * 0.4 + next() * 1.8,
			level = (0.6 + next() * 0.4) / (1 + i * 0.6),
			fade = exp(-1 / ((0.6 + next() * 0.8) * rate)),
		})
	end
	return render(rate, 5.5, variant, function(t, noise)
		local level = 0
		for _, roll in rolls do
			if t >= roll.at then
				level += roll.level * attack(t - roll.at, 0.15)
				roll.level *= roll.fade
			end
		end
		return deeper(rumble(noise())) * level
	end)
end

-- Запись банка: группа громкости, вариантов и чем считается.
local function sound(bus: string, make: (number, number) -> any, variants: number?)
	return { bus = bus, variants = variants or VARIANTS, render = make }
end

local function signalSound(bus: string, tones: { number }, tone: number, gap: number)
	return sound(bus, function(rate, variant)
		return signal(rate, variant, tones, tone, gap)
	end)
end

local function blipSound(from: number, to: number, length: number, click: number)
	return sound("interface", function(rate, variant)
		return blip(rate, variant, from, to, length, click)
	end)
end

local function loopSound(make: (number) -> buffer)
	return { bus = "world", variants = 1, render = function(rate)
		return make(rate)
	end }
end

-- Петли шума — в стерео: у каждого уха своя, и ветер обступает со всех сторон.
local function noiseSound(color: string, seconds: number)
	return { bus = "world", variants = 1, render = function(rate)
		return { dsp.noiseLoop(rate, seconds, 1, color), dsp.noiseLoop(rate, seconds, 2, color) }
	end }
end

return {
	bank = {
		rifle = sound("battle", rifle),
		machinegun = sound("battle", machinegun),
		cannon = sound("battle", cannon),
		launcher = sound("battle", launcher),
		laser = sound("battle", laser),
		arc = sound("battle", arc),
		blast = sound("battle", function(rate, variant)
			return explosion(rate, variant, false)
		end),
		bigBlast = sound("battle", function(rate, variant)
			return explosion(rate, variant, true)
		end),
		-- Тревога: нас атакуют — два спуска вниз.
		attacked = signalSound("interface", { 880, 660, 880, 660 }, 0.11, 0.03),
		-- Интерфейс: щелчок кнопки, касание ячейки при наведении, вход в раздел, отказ.
		click = blipSound(1400, 1100, 0.05, 0.6),
		hover = blipSound(2200, 2200, 0.025, 0.3),
		open = blipSound(700, 1300, 0.09, 0.3),
		deny = blipSound(220, 160, 0.16, 0.2),
		-- Выделение: юниты — бодрый двойной щелчок, здание — один пониже.
		select = signalSound("interface", { 1300, 1700 }, 0.03, 0.015),
		selectBuilding = blipSound(600, 520, 0.08, 0.3),
		-- Приказы: закладка здания, движение, атака.
		place = signalSound("interface", { 520, 780 }, 0.05, 0.02),
		order = blipSound(900, 1250, 0.07, 0.4),
		attackOrder = signalSound("interface", { 1050, 700 }, 0.045, 0.015),
		spotted = signalSound("interface", { 620, 930 }, 0.09, 0.05),
		found = signalSound("interface", { 520, 660, 780 }, 0.08, 0.03),
		nuke = signalSound("interface", { 440, 880, 440, 880, 440 }, 0.2, 0.01),
		nukeClose = signalSound("interface", { 660, 1320, 660, 1320, 660, 1320, 660, 1320 }, 0.12, 0.01),
		ping = signalSound("interface", { 990, 1320, 990 }, 0.07, 0.02),
		intercepted = signalSound("interface", { 660, 880, 1320 }, 0.1, 0.03),
		-- Фоновые петли: работа зданий и шаги пехоты.
		hum = loopSound(hum),
		machinery = loopSound(machinery),
		drill = loopSound(drill),
		steps = loopSound(steps),
		-- Звуки дали: играет их фон, редко и сквозь эхо.
		creak = sound("world", creak),
		clank = sound("world", clank),
		thunder = sound("world", thunder),
		-- Петли шума для ветра и отклик эха.
		["noise:white"] = noiseSound("white", 3),
		["noise:pink"] = noiseSound("pink", 8),
		["noise:brown"] = noiseSound("brown", 8),
		reverb = { bus = "world", variants = 1, render = function(rate)
			return dsp.reverbImpulse(rate, 4, 1)
		end },
		-- Эхо музыки меню — длиннее.
		["reverb:music"] = { bus = "music", variants = 1, render = function(rate)
			return dsp.reverbImpulse(rate, 5, 3)
		end },
	},
}
