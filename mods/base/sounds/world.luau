--!strict
--!native
-- Звуки зданий и мира — перенос packages/client/src/audio/worldSynth.ts: то, что уже есть в игре, — стройка,
-- разворачивание, выезд из завода, ворота, радар, щиты, реактор, корабль космопорта, монеты, перегруз сети, отсчёт и уведомления. Остальное переедет вместе с механиками.

local dsp = require("lib/dsp")

local random, lowpass, highpass, bandpass, render, loop = dsp.random, dsp.lowpass, dsp.highpass, dsp.bandpass, dsp.render, dsp.loop
local decay, attack, pulse, sign = dsp.decay, dsp.attack, dsp.pulse, dsp.sign
local sin, min = math.sin, math.min
local PI = math.pi

-- Металл: звонкие неровные обертоны от основы base, гаснут за time; возвращает сэмпл от времени удара.
local function metal(base: number, time: number, seed: number): (number) -> number
	local next = random(seed)
	local ratios = { 1, 2.32 + next() * 0.2, 3.89 + next() * 0.3, 5.61 + next() * 0.4, 7.13 + next() * 0.5 }
	return function(t: number): number
		local output = 0
		for i, ratio in ratios do
			local k = i - 1
			output += sin(2 * PI * base * ratio * t) * decay(t, time / (1 + k * 0.6)) / (1 + k * 0.7)
		end
		return output
	end
end

-- Лязг: удар металла о металл в момент at секунд, громкостью level.
local function clangAt(rate: number, at: number, base: number, level: number, seed: number): (number, number) -> number
	local ring = metal(base, 0.25, seed)
	local thud = lowpass(rate, 220)
	return function(t: number, n: number): number
		if t < at then
			return thud(0)
		end
		return ring(t - at) * level + thud(n * decay(t - at, 0.02)) * level * 3
	end
end

-- Здание достроено: последний удар — затянутый болт, глухой удар и короткий звонкий аккорд металла.
local function built(rate: number, variant: number)
	local ratchet = bandpass(rate, 3000, 4)
	local clang = clangAt(rate, 0.22, 160, 0.8, variant + 1501)
	return render(rate, 1, variant, function(t, noise)
		local n = noise()
		local clicks = if t < 0.2 then pulse(t, 0.035, 0.003) else 0
		return ratchet(n * clicks) * 3 + clang(t, n)
	end)
end

-- Ворота: шипит гидравлика, створка едет и встаёт с лязгом.
local function gate(rate: number, variant: number)
	local hiss = bandpass(rate, 2500, 1)
	local whine = lowpass(rate, 400)
	local clang = clangAt(rate, 0.55, 120, 0.7, variant + 1401)
	return render(rate, 1, variant, function(t, noise)
		local n = noise()
		local moving = if t < 0.55 then attack(t, 0.05) else 0
		local motor = sin(2 * PI * 110 * t) * 0.25 + whine(n) * 0.6
		return hiss(n) * moving * 0.6 + motor * moving + clang(t, n)
	end)
end

-- MCV разворачивается: гидравлика воет и шипит, опоры встают с ударами, щёлкают замки.
local function deploy(rate: number, variant: number)
	local hiss = bandpass(rate, 2200, 1)
	local clangs = {}
	for i, at in { 0.5, 1.4, 2.2, 3 } do
		clangs[i] = clangAt(rate, at, 90 + (i - 1) * 25, 0.7, variant + 1601 + (i - 1))
	end
	local phase = 0
	return render(rate, 3.4, variant, function(t, noise)
		local n = noise()
		phase += 2 * PI * (180 + 90 * sin(PI * min(1, t / 3))) / rate
		local servo = (((phase / (2 * PI)) % 1) * 2 - 1) * 0.12 * attack(t, 0.1) * min(1, (3.2 - t) / 0.2)
		local output = servo + hiss(n) * pulse(t, 0.9, 0.25, 0.3) * 0.5
		for _, clang in clangs do
			output += clang(t, n)
		end
		return output
	end)
end

-- Машина выехала из завода: шипит воротина, лязгает и катится рольставня.
local function rollout(rate: number, variant: number)
	local hiss = highpass(rate, 2000)
	local rattle = bandpass(rate, 1100, 3)
	local clang = clangAt(rate, 0.5, 130, 0.5, variant + 1701)
	return render(rate, 0.9, variant, function(t, noise)
		local n = noise()
		local shutter = if t < 0.5 then pulse(t, 0.045, 0.006) * attack(t, 0.05) else 0
		return hiss(n) * decay(t, 0.08) * 0.8 + rattle(n * shutter) * 4 + clang(t, n)
	end)
end

-- Радар: мягкий звон импульса, уходящий эхом.
local function radar(rate: number, variant: number)
	local phase = 0
	return render(rate, 1.6, variant, function(t)
		phase += 2 * PI * 1320 * (1 - 0.03 * t) * (1 + variant * 0.008) / rate
		local echo = if t > 0.4 then decay(t - 0.4, 0.3) * 0.3 else 0
		return sin(phase) * (attack(t, 0.003) * decay(t, 0.15) + echo)
	end)
end

-- Реактор: пульс насосов, гул и шелест пара.
local function reactor(rate: number)
	local steam = highpass(rate, 1500)
	local flow = lowpass(rate, 200)
	return loop(rate, 4, function(t, noise)
		local n = noise()
		local pump = pulse(t, 1, 0.25) * sin(2 * PI * 45 * t)
		return pump * 0.8 + sin(2 * PI * 60 * t) * 0.25 + flow(n) * 0.8 + steam(n) * 0.08 * (1 + sin(2 * PI * 0.25 * t))
	end)
end

-- Щит принял удар: всплеск — шум с резким скольжением вниз и дрожащий звон поля.
local function shieldHit(rate: number, variant: number)
	local t = 0
	local sweep = lowpass(rate, function()
		return 600 + 5000 * decay(t, 0.05)
	end)
	local phase = variant * 0.2
	return render(rate, 0.45, variant, function(time, noise)
		t = time
		phase += 2 * PI * (380 + 220 * decay(time, 0.06)) * (1 + 0.02 * sin(2 * PI * 35 * time)) / rate
		return sweep(noise()) * decay(time, 0.05) * 1.3 + sin(phase) * attack(time, 0.004) * decay(time, 0.15) * 0.6
	end)
end

-- Щит пробит: поле гаснет — гул падает вниз, рвётся треском и глохнет.
local function shieldDown(rate: number, variant: number)
	local crackle = highpass(rate, 1500)
	local next = random(variant + 1301)
	local phase, gate, untilAt = 0, 0, 0
	return render(rate, 1.4, variant, function(t, noise)
		if t >= untilAt then
			gate = if next() < 0.5 then next() else 0
			untilAt = t + 0.005 + next() * 0.02
		end
		phase += 2 * PI * (320 * decay(t, 0.5) + 30) / rate
		local hum = (sin(phase) + sin(phase * 2) * 0.4) * decay(t, 0.45)
		return hum * 0.8 + crackle(noise()) * gate * decay(t, 0.35) * 0.9
	end)
end

-- Щит поднялся: гул нарастает снизу вверх и встаёт на ровную ноту.
local function shieldUp(rate: number, variant: number)
	local phase = 0
	return render(rate, 1, variant, function(t)
		phase += 2 * PI * (120 + 260 * min(1, t / 0.6)) * (1 + variant * 0.01) / rate
		return (sin(phase) + sin(phase * 2.01) * 0.35) * attack(t, 0.5) * min(1, (1 - t) / 0.3)
	end)
end

-- Купол щита: ровный высокий гул поля с медленными биениями.
local function dome(rate: number)
	return loop(rate, 4, function(t)
		return (sin(2 * PI * 330 * t) + sin(2 * PI * 330.5 * t) + sin(2 * PI * 660.25 * t) * 0.3) * 0.5
	end)
end

-- Корабль космопорта взлетает: прогрев, рёв двигателей нарастает и уходит вверх, светлея и стихая.
local function shipLaunch(rate: number, variant: number)
	local t = 0
	local roar = lowpass(rate, function()
		return 300 + 2500 * min(1, t / 1.2)
	end)
	local deep = lowpass(rate, 90)
	local phase = 0
	return render(rate, 3.5, variant, function(time, noise)
		t = time
		local n = noise()
		phase += 2 * PI * (300 + 900 * min(1, time / 1.5)) / rate
		local swell = attack(time, 1) * decay(math.max(0, time - 1.3), 0.9)
		return (roar(n) * 2 + deep(n) * 2.5 + sin(phase) * 0.12) * swell
	end)
end

-- Корабль садится: рёв спускается сверху и тяжелеет, касание — глухой удар, шипит сброс давления.
local function shipLand(rate: number, variant: number)
	local t = 0
	local roar = lowpass(rate, function()
		return 2500 - 2100 * min(1, t / 2)
	end)
	local deep = lowpass(rate, 90)
	local hiss = highpass(rate, 2500)
	local touch = lowpass(rate, 150)
	return render(rate, 3.5, variant, function(time, noise)
		t = time
		local n = noise()
		local engine = (roar(n) * 2 + deep(n) * 2) * attack(time, 0.8) * (if time < 2.2 then 1 else decay(time - 2.2, 0.15))
		local thump = if time > 2.2 then touch(n) * decay(time - 2.2, 0.08) * 6 else touch(0)
		local vent = if time > 2.4 then hiss(n) * attack(time - 2.4, 0.03) * decay(time - 2.4, 0.35) * 0.8 else 0
		return engine + thump + vent
	end)
end

-- Деньги пришли: звон монет — несколько ярких металлических ударов вразнобой.
local function coins(rate: number, variant: number)
	local next = random(variant + 3201)
	local hits = {}
	for i = 0, 4 do
		local at = i * 0.05 + next() * 0.03
		table.insert(hits, { at = at, ring = metal(2400 + next() * 900, 0.08, variant * 10 + i) })
	end
	return render(rate, 0.6, variant, function(t)
		local output = 0
		for _, hit in hits do
			if t >= hit.at then
				output += hit.ring(t - hit.at)
			end
		end
		return output
	end)
end

-- Сеть перегружена: свет мигает — гул проседает и рвётся.
local function brownout(rate: number, variant: number)
	local phase = 0
	return render(rate, 1.2, variant, function(t)
		phase += 2 * PI * (100 - 40 * min(1, t / 0.8)) * (1 + variant * 0.015) / rate
		local flicker = if t < 0.6 then 0.4 + 0.6 * (if sin(2 * PI * 9 * t) > -0.2 then 1 else 0) else 1
		return (sin(phase) + sign(sin(phase)) * 0.25 + sin(phase * 3) * 0.2) * flicker * decay(t, 0.45) * attack(t, 0.01)
	end)
end

-- Тон-колокольчик для уведомлений: ноты по очереди через gap, каждая звенит ring секунд.
local function chime(rate: number, variant: number, notes: { number }, gap: number, ring: number)
	return render(rate, gap * (#notes - 1) + ring * 3, variant, function(t)
		local output = 0
		for i, note in notes do
			local localT = t - (i - 1) * gap
			if localT >= 0 then
				local frequency = note * (1 + variant * 0.003)
				output += (sin(2 * PI * frequency * localT) + sin(2 * PI * frequency * 2.76 * localT) * 0.2 * decay(localT, ring / 3)) * attack(localT, 0.004) * decay(localT, ring)
			end
		end
		return output
	end)
end

-- Отсчёт перед ядерным ударом: короткий высокий писк.
local function beep(rate: number, variant: number)
	local phase = 0
	return render(rate, 0.12, variant, function(t)
		phase += 2 * PI * 1760 * (1 + variant * 0.005) / rate
		return (sin(phase) * 0.8 + sign(sin(phase)) * 0.2) * attack(t, 0.003) * min(1, (0.12 - t) / 0.02)
	end)
end

local function sound(bus: string, make)
	return { bus = bus, variants = 3, render = make }
end

local function loopSound(make: (number) -> buffer)
	return { bus = "world", variants = 1, render = function(rate)
		return make(rate)
	end }
end

local function chimeSound(notes: { number }, gap: number, ring: number)
	return sound("interface", function(rate, variant)
		return chime(rate, variant, notes, gap, ring)
	end)
end

return {
	bank = {
		built = sound("world", built),
		gate = sound("world", gate),
		radar = sound("world", radar),
		shipLaunch = sound("world", shipLaunch),
		shipLand = sound("world", shipLand),
		coins = sound("interface", coins),
		shieldHit = sound("world", shieldHit),
		shieldDown = sound("world", shieldDown),
		shieldUp = sound("world", shieldUp),
		-- Петли.
		reactor = loopSound(reactor),
		dome = loopSound(dome),
		deploy = sound("world", deploy),
		rollout = sound("world", rollout),
		brownout = sound("interface", brownout),
		countdown = sound("interface", beep),
		-- Уведомления: машина готова, изучено, улучшено, боеголовка готова, награда, доставлено, защита кончилась.
		unitReady = chimeSound({ 660, 880 }, 0.08, 0.2),
		researched = chimeSound({ 523, 659, 784, 1047 }, 0.09, 0.35),
		upgraded = chimeSound({ 587, 880 }, 0.1, 0.3),
		warheadReady = chimeSound({ 440, 415, 440 }, 0.16, 0.4),
		reward = chimeSound({ 784, 988, 1175 }, 0.07, 0.3),
		delivered = chimeSound({ 659, 784, 659 }, 0.08, 0.25),
		protectionOver = chimeSound({ 880, 659, 523 }, 0.14, 0.3),
	},
}
