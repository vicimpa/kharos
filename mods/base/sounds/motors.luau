--!strict
--!native
-- Моторы техники. У каждого мотора две петли с одинаковым тактом — холостой ход и под нагрузкой: голос плавно переходит
-- от одной к другой, пока водитель жмёт на газ, и крутит их быстрее вслед за оборотами. Под мотором — ход: шорох шин
-- или лязг гусениц, и скрип разворота.

local dsp = require("lib/dsp")

local random, lowpass, highpass, bandpass, render, loop = dsp.random, dsp.lowpass, dsp.highpass, dsp.bandpass, dsp.render, dsp.loop
local decay, attack = dsp.decay, dsp.attack
local sin, floor, exp, max, min = math.sin, math.floor, math.exp, math.max, math.min
local PI = math.pi

-- Сколько секунд длится петля мотора: короче — слышно, что такт повторяется.
local LOOP_SECONDS = 2

local motors = {}

-- Моторы: устройство, во сколько раз обороты на пределе выше холостых, чем звучит ход, стартер, пневмотормоз.
motors.MOTORS = {
	-- Бензиновая четвёрка лёгких машин: бодрая, высоко раскручивается.
	petrol = {
		kind = "combustion",
		spec = { firing = 28, cylinders = 4, pipes = { { 95, 3, 1 }, { 260, 5, 0.55 }, { 820, 4, 0.22 }, { 1900, 3, 0.08 } }, body = 0.7, knock = 0, fade = { 0.004, 0.0025 }, roar = { 0.25, 0.7 } },
		revs = 3.4,
		running = "roll",
		start = "ignition",
		brake = false,
	},
	-- Дизельная шестёрка грузовиков: ниже, стучит, раскручивается недалеко.
	diesel = {
		kind = "combustion",
		spec = { firing = 20, cylinders = 6, pipes = { { 70, 3, 1 }, { 190, 4, 0.6 }, { 560, 4, 0.28 }, { 1300, 3, 0.1 } }, body = 0.9, knock = 0.45, fade = { 0.005, 0.003 }, roar = { 0.3, 0.75 } },
		revs = 2.4,
		running = "roll",
		start = "ignitionDiesel",
		brake = true,
	},
	-- Гусеничные: большой V8 — неровный рокот, самый низкий.
	heavy = {
		kind = "combustion",
		spec = { firing = 16, cylinders = 8, pipes = { { 52, 2.5, 1 }, { 140, 4, 0.75 }, { 400, 4, 0.35 }, { 950, 3, 0.12 } }, body = 1.1, knock = 0.25, fade = { 0.007, 0.004 }, roar = { 0.35, 0.8 } },
		revs = 2.3,
		running = "clatter",
		start = "ignitionDiesel",
		brake = true,
	},
	-- Вертолёт: транспортник и штурмовик.
	rotor = { kind = "rotor", spec = { blades = 13, whine = 1650 }, revs = 1.25, running = nil, start = nil, brake = false },
	-- Дрон: четыре винта.
	props = { kind = "props", spec = { notes = { 190, 197.5, 205, 184.5 } }, revs = 1.6, running = nil, start = nil, brake = false },
	-- Бомбардировщик: турбины.
	jet = { kind = "jet", spec = { whine = 2400 }, revs = 1.3, running = nil, start = nil, brake = false },
}

-- Сколько секунд крутит стартер, прежде чем мотор схватит.
motors.START_CRANK = { ignition = 0.28, ignitionDiesel = 0.4 }

-- Двигатель внутреннего сгорания: вспышки ровно по такту, но цилиндры неодинаковы, и каждая вспышка чуть сдвинута и
-- чуть сильнее или слабее соседней — мотор звучит живым. Такт петли кратен числу цилиндров: она без шва.
local function combustion(rate: number, spec, load: boolean)
	local period = 1 / spec.firing
	local count = max(spec.cylinders, math.round(LOOP_SECONDS * spec.firing / spec.cylinders) * spec.cylinders)
	-- Расписание вспышек одно на обе петли: холостая и нагруженная звучат в такт.
	local next = random(spec.firing * 31 + spec.cylinders)
	local cylinders = {}
	for i = 1, spec.cylinders do
		cylinders[i] = 0.7 + next() * 0.3
	end
	local firings = {}
	for i = 0, count - 1 do
		firings[i + 1] = { shift = next() * 0.05 * period, strength = cylinders[i % spec.cylinders + 1] * (0.9 + next() * 0.2) }
	end
	local fade = spec.fade[if load then 2 else 1]
	local roar = spec.roar[if load then 2 else 1]
	local pipes = {}
	for _, pipe in spec.pipes do
		table.insert(pipes, { filter = bandpass(rate, pipe[1], pipe[2] * 2), weight = pipe[3] })
	end
	local thump = lowpass(rate, if load then 260 else 180)
	local flow = lowpass(rate, if load then 900 else 500)
	local knock = bandpass(rate, 2700, 3)
	local rasp = bandpass(rate, 3400, 2)
	local dc = highpass(rate, 20)
	local index, at, strength = -1, 0, 0
	return loop(rate, count * period, function(t, noise)
		local slot = floor(t / period)
		local firing = firings[slot % count + 1]
		if slot ~= index and t >= slot * period + firing.shift then
			index = slot
			at = t
			strength = firing.strength
		end
		local since = t - at
		local n = noise()
		local kick = strength * (decay(since, fade) - decay(since, 0.0004))
		local burst = strength * n * decay(since, fade * 2.5) * roar
		-- Толчок давления: волна выхлопа длиной в половину такта — из них рокот на частоте вспышек.
		local surge = if since < period * 0.45 then strength * sin(PI * since / (period * 0.45)) else 0
		local pipe = 0
		for _, p in pipes do
			pipe += p.filter(kick + burst) * p.weight
		end
		local output = pipe * 2.2 + thump(surge) * spec.body * 1.4
		-- Поток газа в трубе не стихает между вспышками.
		output += flow(n) * (0.25 + surge * 0.5) * (if load then 0.8 else 0.5)
		output += knock(n) * strength * decay(since, 0.0015) * spec.knock * 3
		if load then
			output += rasp(n) * strength * decay(since, fade * 3) * 0.5
		end
		return dc(output)
	end)
end

-- Вертолёт: каждая лопасть — хлопок воздуха с низким ударом; под нагрузкой хлопки резче, турбина громче.
local function rotor(rate: number, spec, load: boolean)
	local period = 1 / spec.blades
	local wash = lowpass(rate, if load then 1500 else 650)
	local air = lowpass(rate, 400)
	local next = random(spec.blades)
	local strengths = {}
	for i = 1, math.round(LOOP_SECONDS * spec.blades) do
		strengths[i] = 0.85 + next() * 0.15
	end
	return loop(rate, LOOP_SECONDS, function(t, noise)
		local slot = floor(t / period)
		local since = t - slot * period
		local strength = strengths[slot % #strengths + 1]
		local n = noise()
		local slap = wash(n) * decay(since, if load then 0.018 else 0.03) * strength * (if load then 2.6 else 1.8)
		local thump = sin(2 * PI * 48 * since) * decay(since, 0.03) * strength * 0.6
		local whine = (sin(2 * PI * spec.whine * t) + sin(2 * PI * spec.whine * 2 * t) * 0.4) * (if load then 0.09 else 0.05)
		return slap + thump + whine + air(n) * 0.35
	end)
end

-- Дрон: винты звенят пилой каждый на своей ноте, биения между ними — жужжание роя.
local function props(rate: number, spec, load: boolean)
	local tone = lowpass(rate, if load then 3200 else 1800)
	local air = lowpass(rate, 900)
	return loop(rate, LOOP_SECONDS, function(t, noise)
		local saw = 0
		for _, note in spec.notes do
			local phase = (t * note) % 1
			saw += phase * 2 - 1 + (((phase * 2) % 1) * 2 - 1) * (if load then 0.6 else 0.35)
		end
		return tone(saw) * 0.5 + air(noise()) * (if load then 0.5 else 0.3)
	end)
end

-- Турбина: рёв струи — шум с низами, над ним свист компрессора, который чуть плавает.
local function jet(rate: number, spec, load: boolean)
	local roar = lowpass(rate, if load then 1400 else 800)
	local deep = lowpass(rate, 120)
	return loop(rate, LOOP_SECONDS, function(t, noise)
		local n = noise()
		local wobble = 1 + sin(2 * PI * 0.5 * t) * 0.004
		local whine = sin(2 * PI * spec.whine * wobble * t) * 0.12 + sin(2 * PI * spec.whine * 1.5 * wobble * t) * 0.05
		return roar(n) * (if load then 1.6 else 1.1) + deep(n) * 2 + whine * (if load then 1.4 else 1)
	end)
end

local DESIGNS = { combustion = combustion, rotor = rotor, props = props, jet = jet }

-- Лязг гусениц: звенья ложатся на катки по очереди — звонкий щелчок металла и глухой удар; снизу рокочет земля.
local function clatter(rate: number)
	local links = 12
	local period = 1 / links
	local next = random(1201)
	local strengths, shifts = {}, {}
	for i = 1, LOOP_SECONDS * links do
		strengths[i] = 0.5 + next() * 0.5
	end
	for i = 1, #strengths do
		shifts[i] = next() * 0.15 * period
	end
	local plates = { bandpass(rate, 1300, 12), bandpass(rate, 2900, 16), bandpass(rate, 650, 6) }
	local weights = { 1, 0.55, 0.7 }
	local thud = lowpass(rate, 200)
	local ground = lowpass(rate, 110)
	return loop(rate, LOOP_SECONDS, function(t, noise)
		local slot = floor(t / period)
		local since = t - slot * period - shifts[slot % #shifts + 1]
		local strength = if since >= 0 then strengths[slot % #strengths + 1] else 0
		local n = noise()
		local hit = if since >= 0 then n * decay(since, 0.0012) * strength else 0
		local ring = 0
		for i = 1, #plates do
			ring += plates[i](hit) * weights[i]
		end
		return ring * 6 + thud(hit) * 3 + ground(n) * 1.2
	end)
end

-- Шорох шин: шум, глухой снизу, и щелчки гравия из-под колёс.
local function roll(rate: number)
	local next = random(1301)
	local hum = lowpass(rate, 600)
	local deep = lowpass(rate, 90)
	local grit = bandpass(rate, 3200, 2)
	return loop(rate, LOOP_SECONDS, function(_, noise)
		local n = noise()
		local stone = if next() < 0.0012 then 0.6 + next() * 0.4 else 0
		return hum(n) * 0.9 + deep(n) * 2 + grit(stone) * 2.5
	end)
end

-- Скрип разворота на месте: траки трут грунт — шершавый скрежет с металлическим призвуком.
local function squeal(rate: number)
	local bodies = { bandpass(rate, 900, 10), bandpass(rate, 1850, 14), bandpass(rate, 2750, 18) }
	local weights = { 1, 0.6, 0.3 }
	local grind = dsp.wanderer(1401)
	return loop(rate, LOOP_SECONDS, function(t, noise)
		local scrape = noise() * (0.55 + 0.45 * grind(t * 9))
		local output = 0
		for i = 1, #bodies do
			output += bodies[i](scrape) * weights[i]
		end
		return output
	end)
end

-- Визг шин в крутом повороте: тон резины, дрожащий от проскальзывания, и шорох.
local function screech(rate: number)
	local tire = bandpass(rate, 1150, 12)
	local second = bandpass(rate, 2300, 16)
	local slip = dsp.wanderer(1501)
	local phase = 0
	return loop(rate, LOOP_SECONDS, function(t, noise)
		local n = noise()
		local wobble = 1 + 0.03 * sin(2 * PI * 7 * t) + 0.02 * (slip(t * 15) - 0.5)
		phase += 2 * PI * 1150 * wobble / rate
		return sin(phase) * (0.3 + 0.2 * slip(t * 6)) + tire(n) * 1.5 + second(n) * 0.8
	end)
end

-- Стартер: электромотор крутит коленвал, каждый цилиндр на сжатии тормозит его: тон проседает рывками. Потом мотор
-- схватывает: два-три хлопка выхлопа. heavy — дизель: ниже, медленнее, хлопки тяжелее, с клубом выхлопа.
local function ignition(rate: number, variant: number, heavy: boolean)
	local crank = motors.START_CRANK[if heavy then "ignitionDiesel" else "ignition"]
	local humTone = if heavy then 95 else 140
	local pulls = if heavy then 7 else 10
	local length = crank + 0.28
	local gears = bandpass(rate, if heavy then 900 else 1300, 4)
	local body = lowpass(rate, 600)
	local pipe = bandpass(rate, if heavy then 75 else 105, 2.5)
	local knock = bandpass(rate, 2400, 3)
	local puff = lowpass(rate, 400)
	local phase = 0
	return render(rate, length, variant, function(t, noise)
		local n = noise()
		local output = 0
		if t < crank + 0.03 then
			local cycle = (t * pulls) % 1
			local loadNow = exp(-cycle * 6)
			phase += humTone * (1 - 0.25 * loadNow) / rate
			local tone = sin(2 * PI * phase) + 0.35 * sin(4 * PI * phase) + 0.15 * sin(6 * PI * phase)
			local level = (0.45 + 0.55 * (1 - loadNow)) * attack(t, 0.015) * min(1, (crank + 0.03 - t) / 0.03)
			output += (tone * 0.4 + body(n) * 0.5 + gears(n) * 0.35) * level
		end
		if t >= crank then
			local localT = t - crank
			for i, at in { 0, 0.07, 0.12 } do
				local since = localT - at
				if since >= 0 then
					local k = i - 1
					local kick = (1.2 - k * 0.2) * (decay(since, if heavy then 0.012 else 0.008) - decay(since, 0.0006))
					output += pipe(kick + n * kick * 0.5) * 4 + kick * 0.5
					if heavy then
						output += knock(n) * decay(since, 0.002) * (1 - k * 0.25)
					end
				end
			end
			if heavy then
				output += puff(n) * decay(localT, 0.1) * 0.8
			end
			output *= min(1, (length - t) / 0.08)
		end
		return output
	end)
end

-- Пневмотормоз: щелчок клапана и шипение сброшенного воздуха, которое темнеет и стихает.
local function airBrake(rate: number, variant: number)
	local t = 0
	local hiss = highpass(rate, 1800)
	local tone = lowpass(rate, function()
		return 3000 + 5000 * decay(t, 0.15)
	end)
	local click = bandpass(rate, 1400, 4)
	return render(rate, 0.8, variant, function(time, noise)
		t = time
		local n = noise()
		return tone(hiss(n)) * attack(t, 0.006) * decay(t, 0.22) * 1.6 + click(n) * decay(t, 0.004) * 3
	end)
end

-- Банк: петли моторов (холостой ход и под нагрузкой), петли хода, стартеры и тормоз.
local bank = {}
for name, motor in motors.MOTORS do
	for _, load in { false, true } do
		bank["motor:" .. name .. ":" .. (if load then "load" else "idle")] = { bus = "world", variants = 1, render = function(rate)
			return DESIGNS[motor.kind](rate, motor.spec, load)
		end }
	end
end
for name, make in { clatter = clatter, roll = roll, squeal = squeal, screech = screech } do
	bank["running:" .. name] = { bus = "world", variants = 1, render = function(rate)
		return make(rate)
	end }
end
bank.ignition = { bus = "world", variants = 3, render = function(rate, variant)
	return ignition(rate, variant, false)
end }
bank.ignitionDiesel = { bus = "world", variants = 3, render = function(rate, variant)
	return ignition(rate, variant, true)
end }
bank.airBrake = { bus = "world", variants = 3, render = airBrake }
motors.bank = bank

-- Голос одной машины: две петли мотора крутятся с одной скоростью и с одного места — такты совпадают, голос перетекает
-- от холостой к нагруженной. Под ними ход и скрип разворота. Всё через срез верхов: на газу и вблизи звук ярче. args =
-- { motor, running, squeal } — имена: мотор, петля хода, петля скрипа (или nil).
local GLIDE = 0.06
local RUNNING_LEVEL = 0.55
local SQUEAL_LEVEL = 0.35

motors.graph = function(s)
	local args = s.args
	local tone = s:filter("lowpass", 500, 0.7)
	local engine = s:gain(0)
	tone:to(engine):to(s:out())
	-- Одна случайная точка начала на обе петли мотора: такты холостой и нагруженной совпадают.
	local offset = math.random() * LOOP_SECONDS
	local idle = s:sample("motor:" .. args.motor .. ":idle", { loop = true, offset = offset })
	local loaded = s:sample("motor:" .. args.motor .. ":load", { loop = true, offset = offset })
	local idleGain, loadGain = s:gain(0), s:gain(0)
	idle:to(idleGain):to(tone)
	loaded:to(loadGain):to(tone)
	local nodes = { tone = tone, engine = engine, idle = idle, loaded = loaded, idleGain = idleGain, loadGain = loadGain }
	if args.running then
		nodes.ground = s:sample("running:" .. args.running, { loop = true })
		nodes.groundGain = s:gain(0)
		nodes.ground:to(nodes.groundGain):to(s:out())
	end
	if args.squeal then
		nodes.scrape = s:sample("running:" .. args.squeal, { loop = true })
		nodes.scrapeGain = s:gain(0)
		nodes.scrape:to(nodes.scrapeGain):to(s:out())
	end
	return nodes
end

-- Ручки: rate (скорость петли), load (0..1), level, running, runningRate, squeal, clarity.
motors.update = function(n, sound)
	for _, source in { n.idle, n.loaded } do
		source.rate:glide(max(0.1, sound.rate), GLIDE)
	end
	-- Переход холостая — нагрузка по четверти круга: суммарная громкость не проседает посередине.
	local angle = math.clamp(sound.load, 0, 1) * PI / 2
	n.idleGain.gain:glide(math.cos(angle), GLIDE)
	n.loadGain.gain:glide(sin(angle) * 1.2, GLIDE)
	n.engine.gain:glide(sound.level, GLIDE * 2)
	-- На газу и на высоких оборотах звук светлее; издалека верхи тонут.
	local bright = (500 + 3500 * sound.load) * (0.7 + 0.3 * sound.rate)
	n.tone.frequency:glide(min(16000, bright * (0.35 + 0.65 * sound.clarity)), GLIDE)
	if n.ground then
		n.ground.rate:glide(max(0.05, sound.runningRate), GLIDE)
		n.groundGain.gain:glide(sound.running * RUNNING_LEVEL, GLIDE * 2)
	end
	if n.scrape then
		n.scrapeGain.gain:glide(sound.squeal * SQUEAL_LEVEL, GLIDE * 2)
	end
end

return motors
