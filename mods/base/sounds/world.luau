--!strict
--!native
-- Звуки зданий и мира: стройка, разворачивание, выезд из завода, петли стройки, сварки, луча, турелей, накопителей,
-- труб и перегруза, ворота, груз на земле, радар, щиты, реактор, корабль космопорта, монеты, ядерный пуск и взрыв,
-- перегруз сети, отсчёт, уведомления, поражение и сдача.

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

-- Груз упал на землю: глухой удар ящиков и стук.
local function crates(rate: number, variant: number)
	local thud = lowpass(rate, 260)
	local wood = bandpass(rate, 600, 4)
	return render(rate, 0.5, variant, function(t, noise)
		local n = noise()
		local hits = decay(t, 0.03) + (if t > 0.09 then decay(t - 0.09, 0.02) * 0.6 else 0)
		return thud(n * hits) * 4 + wood(n * hits) * 2
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

-- Перегрузка электростанции: треск дуг — шум, рвущийся на вспышки, — поверх надсадного гудения сети (overload).
local function overload(rate: number)
	local next = random(2001)
	local crackle = highpass(rate, 1800)
	local snap = bandpass(rate, 900, 2)
	local gate, untilAt = 0, 0
	return loop(rate, 3, function(t, noise)
		if t >= untilAt then
			-- Разряды идут пачками: то густо, то пусто.
			local burst = sin(2 * PI * 0.7 * t) > -0.3
			gate = if burst and next() < 0.45 then 0.3 + next() * 0.7 else 0
			untilAt = t + 0.002 + next() * 0.01
		end
		local n = noise()
		local strain = sign(sin(2 * PI * 100 * t)) * 0.12 + sin(2 * PI * 150 * t) * 0.1
		return crackle(n) * gate * 1.3 + snap(n) * gate * 0.8 + strain * (0.8 + 0.2 * sin(2 * PI * 3 * t))
	end)
end

-- Стройка: удары молота, трещотка гайковёрта и шипение сварки — вразнобой (construct).
local function construct(rate: number)
	local hammer = clangAt(rate, 0, 380, 0.5, 2101)
	local ratchet = bandpass(rate, 3200, 5)
	local hiss = highpass(rate, 3000)
	return loop(rate, 4, function(t, noise)
		local n = noise()
		local knock = hammer(((t % 0.7) + 0.7) % 0.7, n) * (if t % 2.8 < 2.1 then 1 else 0)
		local drive = if t > 2.2 and t < 3.2 then ratchet(n * pulse(t, 0.03, 0.002)) * 2 else ratchet(0)
		local spark = hiss(n) * (0.2 + 0.2 * sin(2 * PI * 0.6 * t)) * 0.4
		return knock + drive + spark
	end)
end

-- Сварка ремонта: треск дуги — рваное шипение — и гул аппарата (weld).
local function weld(rate: number)
	local next = random(2201)
	local hiss = highpass(rate, 2500)
	local level, untilAt = 0, 0
	return loop(rate, 2, function(t, noise)
		if t >= untilAt then
			level = 0.4 + next() * 0.6
			untilAt = t + 0.01 + next() * 0.05
		end
		return hiss(noise()) * level + sign(sin(2 * PI * 100 * t)) * 0.08
	end)
end

-- Луч грузовика: переливчатый гул, который дышит, — груз течёт по лучу (tractor).
local function tractor(rate: number)
	return loop(rate, 2, function(t)
		local wobble = sin(2 * PI * 3 * t)
		return (sin(2 * PI * 220 * t + wobble * 2) * 0.6 + sin(2 * PI * 331 * t + wobble) * 0.3 + sin(2 * PI * 660 * t) * 0.1) * (0.7 + 0.3 * sin(2 * PI * 1.5 * t))
	end)
end

-- Поворот турели: зуд моторчика и скрип шестерён (servo).
local function servo(rate: number)
	local gear = bandpass(rate, 1800, 6)
	return loop(rate, 2, function(t, noise)
		local phase = (t * 240) % 1
		return (phase * 2 - 1) * 0.4 + gear(noise()) * 0.6 + sin(2 * PI * 480 * t) * 0.15
	end)
end

-- Накопитель заряжается или отдаёт: тонкий писк, который дышит (charge).
local function charge(rate: number)
	return loop(rate, 2, function(t)
		return sin(2 * PI * 3200 * t) * 0.3 + sin(2 * PI * 1600 * t) * 0.3 * (0.6 + 0.4 * sin(2 * PI * 2 * t))
	end)
end

-- Груз в трубах: бульканье и ровный шум потока (flow).
local function flow(rate: number)
	local gurgle = bandpass(rate, 350, 4)
	local rush = lowpass(rate, 700)
	local swirl = random(2401)
	local level, untilAt = 0.5, 0
	return loop(rate, 3, function(t, noise)
		if t >= untilAt then
			level = 0.3 + swirl() * 0.7
			untilAt = t + 0.03 + swirl() * 0.08
		end
		local n = noise()
		return gurgle(n) * level * 2 + rush(n) * 0.8
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

-- Ядерный взрыв: оглушительный удар, огромный бас и раскаты — один за другим, всё дальше; через полсекунды — ударная
-- волна, второй тупой удар и рёв ветра.
local function nuke(rate: number, variant: number)
	local t = 0
	local body = lowpass(rate, function()
		return 90 + 1600 * decay(t, 0.3)
	end)
	local wind = bandpass(rate, 450, 0.8)
	local rolls = lowpass(rate, 160)
	local next = random(variant + 1001)
	local thunders = {}
	for i = 0, 4 do
		table.insert(thunders, { at = 1.2 + i * 0.7 + next() * 0.6, level = 0.8 / (1 + i * 0.4) })
	end
	local phase = 0
	return render(rate, 6, variant, function(time, noise)
		t = time
		local n = noise()
		phase += 2 * PI * (24 + 30 * decay(time, 0.4)) / rate
		local blast = body(n) * attack(time, 0.003) * decay(time, 1.1) * 3 + sin(phase) * decay(time, 1.4) * 1.3
		local wave = if time > 0.55 then (sin(2 * PI * 40 * (time - 0.55)) * decay(time - 0.55, 0.15) * 0.4 + wind(n) * decay(time - 0.55, 1.2) * 2.5) * attack(time - 0.55, 0.01) else wind(0)
		local rolling = 0
		for _, thunder in thunders do
			if time >= thunder.at then
				rolling += thunder.level * attack(time - thunder.at, 0.2) * decay(time - thunder.at, 0.9)
			end
		end
		return blast + wave + rolls(n) * rolling * 3
	end)
end

-- Створки шахты встали: тяжёлый замок — глухой удар и звон металла.
local function doorsLocked(rate: number, variant: number)
	local clang = clangAt(rate, 0, 95, 1, variant + 1101)
	local second = clangAt(rate, 0.12, 140, 0.6, variant + 1111)
	return render(rate, 1.2, variant, function(t, noise)
		local n = noise()
		return clang(t, n) + second(t, n)
	end)
end

-- Старт ракеты: зажигание — хлопок и треск, — двигатель выходит на полную тягу с рёвом, и ракета уходит вверх.
local function liftoff(rate: number, variant: number)
	local t = 0
	local roar = lowpass(rate, function()
		return 300 + 2200 * min(1, t / 0.6) * decay(math.max(0, t - 1.5), 1.5)
	end)
	local crackle = highpass(rate, 2000)
	local deep = lowpass(rate, 80)
	local next = random(variant + 1201)
	local gate, untilAt = 1, 0
	return render(rate, 5, variant, function(time, noise)
		t = time
		local n = noise()
		if time >= untilAt then
			gate = 0.3 + next() * 0.7
			untilAt = time + 0.004 + next() * 0.02
		end
		local swell = attack(time, 0.4) * decay(math.max(0, time - 1.2), 1.4)
		return (roar(n) * 2.6 + crackle(n) * gate * 0.35 + deep(n) * 3) * swell + crackle(n) * decay(time, 0.03) * 1.5
	end)
end

-- Гидравлика: створки шахты расходятся — ровный вой насоса и шипение.
local function hydraulic(rate: number)
	local hiss = bandpass(rate, 2200, 1.5)
	return loop(rate, 2, function(t, noise)
		local phase = (t * 140) % 1
		return (phase * 2 - 1) * 0.35 + sin(2 * PI * 280 * t) * 0.2 + hiss(noise()) * 0.5
	end)
end

-- Пар из шахты: широкое шипение, пульсирующее клубами.
local function steam(rate: number)
	local hiss = highpass(rate, 800)
	local body = lowpass(rate, 3000)
	return loop(rate, 3, function(t, noise)
		return body(hiss(noise())) * (0.6 + 0.4 * sin(2 * PI * (2 / 3) * t) ^ 2)
	end)
end

-- Ракетный двигатель: рёв струи с треском — для разгона в шахте и для ракеты в полёте.
local function rocket(rate: number)
	local next = random(2301)
	local roar = lowpass(rate, 1400)
	local deep = lowpass(rate, 90)
	local crackle = highpass(rate, 2500)
	local gate, untilAt = 0, 0
	return loop(rate, 3, function(t, noise)
		if t >= untilAt then
			gate = if next() < 0.5 then 0.3 + next() * 0.7 else 0
			untilAt = t + 0.003 + next() * 0.015
		end
		local n = noise()
		return roar(n) * 2 + deep(n) * 3 + crackle(n) * gate * 0.4
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

-- Поражение: тяжёлый низкий аккорд, который сползает вниз и гаснет.
local function defeat(rate: number, variant: number)
	local notes = { 110, 130.8, 164.8 }
	return render(rate, 4, variant, function(t)
		local slide = (1 - 0.06 * min(1, t / 3)) * (1 + variant * 0.006)
		local output = 0
		for _, note in notes do
			local f = note * slide
			output += (sin(2 * PI * f * t) + sin(2 * PI * f * 2 * t) * 0.3 + sin(2 * PI * f * 3 * t) * 0.12) / #notes
		end
		return output * attack(t, 0.15) * decay(t, 1.4)
	end)
end

-- Капитуляция: долгий низкий гудок сирены — база гибнет волной.
local function surrender(rate: number, variant: number)
	local phase = 0
	return render(rate, 3, variant, function(t)
		phase += 2 * PI * (150 + 40 * sin(PI * min(1, t / 3))) * (1 + variant * 0.01) / rate
		return (sin(phase) + sign(sin(phase)) * 0.2 + sin(phase * 1.5) * 0.3) * attack(t, 0.3) * min(1, (3 - t) / 0.6)
	end)
end

-- Огнемёт: хлопок поджига и рёв струи — шум, который вспыхивает и гаснет, со светлым шипением сверху (flame).
local function flame(rate: number, variant: number)
	local t = 0
	local roar = lowpass(rate, function()
		return 700 + 1500 * decay(t, 0.12)
	end)
	local hiss = highpass(rate, 3000)
	local flutter = random(variant + 601)
	local gust = 1
	return render(rate, 0.55, variant, function(time, noise)
		t = time
		if math.floor(time * 60) ~= math.floor((time - 1 / rate) * 60) then
			gust = 0.7 + flutter() * 0.3
		end
		local n = noise()
		return (roar(n) * 2.4 * gust + hiss(n) * 0.25) * attack(time, 0.02) * decay(time, 0.18)
	end)
end

-- Зенитка: сухой хлопок выстрела и тугой «тумп» снаряда, как удар по барабану (flak).
local function flak(rate: number, variant: number)
	local crack = highpass(rate, 2200)
	local body = lowpass(rate, 500)
	local phase = 0
	return render(rate, 0.35, variant, function(t, noise)
		local n = noise()
		phase += 2 * PI * (90 + 140 * decay(t, 0.02)) / rate
		return crack(n) * decay(t, 0.006) * 0.8 + body(n) * decay(t, 0.05) * 1.6 + sin(phase) * decay(t, 0.07) * 0.8
	end)
end

-- Гаубица: удар ниже пушечного, раскат катится дольше и уходит эхом (artillery).
local function artillery(rate: number, variant: number)
	local crack = highpass(rate, 1200)
	local rumble = lowpass(rate, 220)
	local echo = lowpass(rate, 400)
	local phase = 0
	return render(rate, 1.9, variant, function(t, noise)
		local n = noise()
		phase += 2 * PI * (30 + 50 * decay(t, 0.15)) / rate
		local tail = if t > 0.35 then echo(n) * decay(t - 0.35, 0.45) * 0.9 else echo(0)
		return crack(n) * decay(t, 0.015) * 0.9 + sin(phase) * decay(t, 0.4) + rumble(n) * decay(t, 0.5) * 2.6 + tail
	end)
end

-- Бомба: свист падения — тон сползает вниз и крепнет.
local function bombFall(rate: number, variant: number)
	local phase = variant * 0.3
	local air = bandpass(rate, 1400, 3)
	return render(rate, 0.9, variant, function(t, noise)
		phase += 2 * PI * (1500 - 700 * (t / 0.9)) / rate
		local swell = attack(t, 0.5) * min(1, (0.9 - t) / 0.05)
		return (sin(phase) * 0.5 + air(noise()) * 0.8) * swell
	end)
end

-- Пуля попала: короткий щелчок о броню, иногда со звоном рикошета (ricochet).
local function ricochet(rate: number, variant: number)
	local next = random(variant + 701)
	local whine = next() < 0.6
	local start = 2800 + next() * 1600
	local tick = highpass(rate, 2500)
	local phase = 0
	return render(rate, if whine then 0.3 else 0.06, variant, function(t, noise)
		phase += 2 * PI * start * (1 - 0.35 * min(1, t / 0.3)) / rate
		return tick(noise()) * decay(t, 0.004) * 1.2 + (if whine then sin(phase) * attack(t, 0.01) * decay(t, 0.08) * 0.35 else 0)
	end)
end

-- Подбитая машина: скрежет и хруст смятого металла после взрыва, долгий звон обшивки (wreck).
local function wreck(rate: number, variant: number)
	local next = random(variant + 801)
	local crunch = bandpass(rate, 900 + next() * 400, 2)
	local ring = metal(180 + next() * 120, 0.6, variant + 811)
	local rattle = highpass(rate, 1500)
	return render(rate, 1.4, variant, function(t, noise)
		local n = noise()
		local grit = if t < 0.5 then crunch(n) * (0.5 + 0.5 * sin(2 * PI * 23 * t) ^ 2) * decay(t, 0.15) * 2 else crunch(0)
		return grit + ring(t) * 0.5 + rattle(n) * (if next() < 0.003 then 1 else 0) * decay(t, 0.5) * 3
	end)
end

-- Рушится здание: глухой обвал — рокот, удары падающих плит и сыплющийся щебень (collapse).
local function collapse(rate: number, variant: number)
	local next = random(variant + 901)
	local rumble = lowpass(rate, 140)
	local debris = bandpass(rate, 700, 1.5)
	local grit = highpass(rate, 2500)
	local falls = {}
	for i = 1, 7 do
		falls[i] = { at = 0.15 + next() * 1.6, level = 0.5 + next() * 0.5 }
	end
	local thuds = lowpass(rate, 300)
	return render(rate, 2.6, variant, function(t, noise)
		local n = noise()
		local hits = 0
		for _, fall in falls do
			if t >= fall.at then
				hits += decay(t - fall.at, 0.05) * fall.level
			end
		end
		local sprinkle = if next() < 0.02 * decay(t, 0.9) then 1 else 0
		return rumble(n) * attack(t, 0.05) * decay(t, 0.8) * 3 + thuds(n * hits) * 4 + debris(n) * decay(t, 0.6) * 0.6 + grit(sprinkle) * 0.8
	end)
end

-- Лазер попал: шипение прожжённого металла — шум, который тает, с тонким звоном (sizzle).
local function sizzle(rate: number, variant: number)
	local hiss = highpass(rate, 3500)
	local phase = variant
	return render(rate, 0.35, variant, function(t, noise)
		phase += 2 * PI * 2600 / rate
		return hiss(noise()) * attack(t, 0.005) * decay(t, 0.1) * 1.2 + sin(phase) * decay(t, 0.05) * 0.2
	end)
end

-- Огонь лизнул цель: потрескивание горящего — щелчки поверх тихого гула пламени (burn).
local function burn(rate: number, variant: number)
	local next = random(variant + 3101)
	local roar = lowpass(rate, 500)
	local pop = bandpass(rate, 1800, 2)
	return render(rate, 0.5, variant, function(t, noise)
		local n = noise()
		local crack = if next() < 0.004 then 1 else 0
		return roar(n) * decay(t, 0.2) * 1.4 + pop(crack) * 4 * decay(t, 0.3)
	end)
end

-- Разряд ударил в цель: сухой щелчок и треск (zap).
local function zap(rate: number, variant: number)
	local snap = highpass(rate, 2000)
	local body = bandpass(rate, 700, 2)
	return render(rate, 0.18, variant, function(t, noise)
		local n = noise()
		return snap(n) * decay(t, 0.008) * 1.5 + body(n) * decay(t, 0.03) * (0.6 + 0.4 * sign(sin(2 * PI * 90 * t)))
	end)
end

-- Покрытие легло: шлепок плиты и короткий скрежет мастерка (paved).
local function paved(rate: number, variant: number)
	local slap = lowpass(rate, 400)
	local scrape = bandpass(rate, 2500, 2)
	return render(rate, 0.45, variant, function(t, noise)
		local n = noise()
		return slap(n) * decay(t, 0.04) * 3 + scrape(n) * (if t > 0.08 then attack(t - 0.08, 0.05) * decay(t - 0.08, 0.1) else 0) * 0.8
	end)
end

-- Месторождение выработано: бур захлёбывается и встаёт, два нисходящих тона (depleted).
local function depleted(rate: number, variant: number)
	local grit = lowpass(rate, 900)
	local phase = 0
	return render(rate, 1.4, variant, function(t, noise)
		phase += 2 * PI * 95 * decay(t, 0.5) / rate
		local drill = (((phase / (2 * PI)) % 1 * 2 - 1) * 0.4 + grit(noise())) * decay(t, 0.35)
		local tones = (if t > 0.5 then sin(2 * PI * 330 * t) * decay(t - 0.5, 0.15) else 0) + (if t > 0.75 then sin(2 * PI * 247 * t) * decay(t - 0.75, 0.25) else 0)
		return drill + tones * 0.5
	end)
end

-- Рубильник: щелчок и гул, который разгоняется (включили) или стихает (выключили) (power).
local function power(rate: number, variant: number, on: boolean)
	local click = bandpass(rate, 1500, 3)
	local phase = 0
	return render(rate, 0.8, variant, function(t, noise)
		local sweep = if on then min(1, t / 0.5) else 1 - min(1, t / 0.6)
		phase += 2 * PI * (40 + 80 * sweep) / rate
		local hum = (sin(phase) + sin(phase * 2) * 0.4) * (if on then attack(t, 0.1) * min(1, (0.8 - t) / 0.3) else decay(t, 0.3))
		return click(noise()) * decay(t, 0.006) * 4 + hum * 0.6
	end)
end

-- Грузовик загрузился или опустел: глухой удар и звон кузова (cargo).
local function cargo(rate: number, variant: number)
	local thud = lowpass(rate, 220)
	local ring = metal(260 + variant * 20, 0.12, variant + 3301)
	return render(rate, 0.4, variant, function(t, noise)
		return thud(noise()) * decay(t, 0.03) * 3 + ring(t) * 0.35
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
		crates = sound("world", crates),
		radar = sound("world", radar),
		nukeBlast = sound("battle", nuke),
		doorsLocked = sound("world", doorsLocked),
		liftoff = sound("world", liftoff),
		shipLaunch = sound("world", shipLaunch),
		shipLand = sound("world", shipLand),
		coins = sound("interface", coins),
		shieldHit = sound("battle", shieldHit),
		shieldDown = sound("world", shieldDown),
		shieldUp = sound("world", shieldUp),
		-- Петли.
		reactor = loopSound(reactor),
		flame = sound("battle", flame),
		flak = sound("battle", flak),
		artillery = sound("battle", artillery),
		bombFall = sound("battle", bombFall),
		ricochet = sound("battle", ricochet),
		wreck = sound("battle", wreck),
		collapse = sound("battle", collapse),
		sizzle = sound("battle", sizzle),
		burn = sound("battle", burn),
		zap = sound("battle", zap),
		paved = sound("world", paved),
		depleted = sound("world", depleted),
		powerOn = sound("world", function(rate, variant)
			return power(rate, variant, true)
		end),
		powerOff = sound("world", function(rate, variant)
			return power(rate, variant, false)
		end),
		cargo = sound("world", cargo),
		overload = loopSound(overload),
		construct = loopSound(construct),
		weld = loopSound(weld),
		tractor = loopSound(tractor),
		servo = loopSound(servo),
		charge = loopSound(charge),
		flow = loopSound(flow),
		dome = loopSound(dome),
		hydraulic = loopSound(hydraulic),
		steam = loopSound(steam),
		rocket = loopSound(rocket),
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
		defeat = sound("interface", defeat),
		surrender = sound("interface", surrender),
	},
}
