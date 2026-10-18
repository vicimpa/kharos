--!strict
-- Фон заброшенной пустой земли под низким небом. Всё время дует ветер, порывами; в развалинах гудит и воет; в непогоду
-- шуршат песок и дождь. Под этим — едва слышная медленная подложка в миноре, а вдалеке, сквозь эхо, изредка скрипит
-- ржавый металл, лязгает железо или, в бурю, рокочет гром. Ветер крепнет с погодой и высотой камеры, подложка ночью
-- темнее и реже. Тревога и бой (пульс, гул пилы) ждут боя на движке: пока их нет, они на нуле.

local dsp = require("lib/dsp")

-- Громкости слоёв фона. Все тихие: фон слышен, когда в игре затишье.
local WIND_LEVEL = 0.14
local HOWL_LEVELS = { 2.4, 1.5 }
local HISS_LEVEL = 0.22
local PAD_LEVEL = 0.017
local DISTANT_LEVEL = 0.18
local REVERB_LEVEL = 0.55
local FADE_IN = 6
local STEP = 0.1
local HOWLS = { { frequency = 420, drift = 0.25, q = 9 }, { frequency = 780, drift = 0.2, q = 14 } }
-- Аккорды подложки: ре минор — си-бемоль — до — ля минор, медленно и по кругу; первая нота — бас.
local CHORDS = {
	{ 38, 57, 62, 65, 69, 76 },
	{ 34, 53, 57, 62, 65, 72 },
	{ 36, 55, 60, 64, 67, 74 },
	{ 33, 52, 57, 60, 64, 71 },
}
local CHORD_TIME = 24
local NOTE_GAP = { 2.5, 5 }
local DISTANT_GAP = { 9, 26 }
local EASE = {
	threat = { rise = 6, fall = 30 },
	battle = { rise = 4, fall = 25 },
	biome = { rise = 25, fall = 25 },
}
local PULSE_LEVEL = 0.11
local PULSE_BEAT = { 1.7, 0.8 }
local PULSE_ECHO = 0.28
local PULSE_ECHO_LEVEL = 0.45
local DRONE_LEVEL = 0.025
local TRIUMPH_SECONDS = 40
local ERG_SUB = 0.5
local SALT_BELL = 0.35
local RED_GRIT = 0.12
-- Ветер погоды, тайлов в секунду, при котором фон дует во всю силу; масштабы камеры для высоты.
local STRONG_WIND = 2.5
local MIN_ZOOM, MAX_ZOOM = 4, 96

local function midi(note: number): number
	return 440 * 2 ^ ((note - 69) / 12)
end

local function clamp01(value: number): number
	return math.clamp(value, 0, 1)
end

local function ease(value: number, target: number, seconds: number, spec): number
	return value + (target - value) * (1 - math.exp(-seconds / (if target > value then spec.rise else spec.fall)))
end

-- Плавное число от −1 до 1, которое медленно бродит.
local function wander(seed: number): (number) -> number
	local function value(step: number): number
		local next = dsp.random(seed * 1000003 + step * 7919 + 1)
		next()
		return next() * 2 - 1
	end
	return function(t: number): number
		local step = math.floor(t)
		local f = t - step
		local a = value(step)
		return a + (value(step + 1) - a) * f * f * (3 - 2 * f)
	end
end

-- Основа фона: ветер, гулы, шорох, фильтры подложки и пульса, гул боя, эхо — один голос, который звучит всегда.
local BED = {
	graph = function(s)
		local out = s:out()
		out.gain:set(0, s.at)
		out.gain:ramp(1, s.at + FADE_IN)
		local reverb = s:reverb("reverb")
		local reverbGain = s:gain(REVERB_LEVEL)
		reverb:to(reverbGain):to(out)

		local windFilter = s:filter("lowpass", 400, 0.7)
		local windGain = s:gain(0)
		s:sample("noise:brown", { loop = true, offset = 0 }):to(windFilter):to(windGain):to(out)

		local howls = {}
		for i, howl in HOWLS do
			local band = s:filter("bandpass", howl.frequency, howl.q)
			local level = s:gain(0)
			local panner = s:pan(0)
			s:sample("noise:pink", { loop = true, offset = 2.1 + (i - 1) * 3.3 }):to(band):to(level):to(panner)
			panner:to(out)
			panner:to(reverb)
			howls[i] = { band = band, level = level, panner = panner }
		end

		local hissGain = s:gain(0)
		s:sample("noise:white", { loop = true, offset = 0.7 }):to(s:filter("highpass", 1500, 0.7)):to(s:filter("lowpass", 6500, 0.7)):to(hissGain):to(out)

		local padFilter = s:filter("lowpass", 900, 0.7)
		local padGain = s:gain(PAD_LEVEL)
		padFilter:to(padGain)
		local padDry, padWet = s:gain(1), s:gain(1)
		padGain:to(padDry):to(out)
		padGain:to(padWet):to(reverb)

		local pulseFilter = s:filter("lowpass", 260, 0.7)
		pulseFilter:to(s:gain(1)):to(out)

		local droneFilter = s:filter("lowpass", 150, 1.2)
		local droneGain = s:gain(0)
		droneFilter:to(droneGain)
		droneGain:to(out)
		droneGain:to(reverb)
		local drones = {}
		for _, detune in { -7, 7 } do
			local oscillator = s:osc("sawtooth", midi(CHORDS[1][1]))
			oscillator.detune:set(detune)
			oscillator:to(droneFilter)
			table.insert(drones, oscillator)
		end
		return {
			reverb = reverb, windFilter = windFilter, windGain = windGain, howls = howls, hissGain = hissGain, padFilter = padFilter,
			padGain = padGain, padDry = padDry, padWet = padWet, pulseFilter = pulseFilter, droneFilter = droneFilter, droneGain = droneGain, drones = drones,
		}
	end,
}

-- Нота подложки: всплывает за rise секунд, держится hold и тает за fade. Окраска биома — нижняя октава, звон и дребезг.
local NOTE = {
	graph = function(s)
		local a = s.args
		local at, rise, hold, fade, level, color = s.at, a.rise, a.hold, a.fade, a.level, a.color
		local endAt = at + rise + hold + fade
		local envelope = s:gain(0)
		envelope.gain:set(0, at)
		envelope.gain:ramp(level, at + rise)
		envelope.gain:set(level, at + rise + hold)
		envelope.gain:ramp(0, endAt)
		envelope:to(s:out())
		local voices = {
			{ wave = "sine", ratio = 1, detune = -4, level = 1 },
			{ wave = "triangle", ratio = 1, detune = 5, level = 0.45 },
			{ wave = "sine", ratio = 0.5, detune = 0, level = ERG_SUB * color.sub },
			{ wave = "square", ratio = 1, detune = 13, level = RED_GRIT * color.grit },
		}
		for _, voice in voices do
			if voice.level > 0.01 then
				local oscillator = s:osc(voice.wave, a.frequency * voice.ratio)
				oscillator.detune:set(voice.detune)
				oscillator:to(s:gain(voice.level)):to(envelope)
			end
		end
		-- Звон — своя огибающая: вступает с нотой и тает раньше неё, как удар по стеклу.
		if color.bell > 0.01 then
			local ring = s:gain(0)
			local peak = at + math.min(rise, 0.4)
			ring.gain:set(0, at)
			ring.gain:ramp(level * SALT_BELL * color.bell, peak)
			ring.gain:exp(0.0001, peak + 3)
			s:osc("sine", a.frequency * 3):to(ring):to(s:out())
		end
	end,
}

-- Удар пульса: низкая нота, вступает сразу и тает за секунду.
local BEAT = {
	graph = function(s)
		local a = s.args
		local envelope = s:gain(0)
		envelope.gain:set(0, s.at)
		envelope.gain:ramp(a.level, s.at + 0.04)
		envelope.gain:exp(0.0001, s.at + 0.9)
		envelope:to(s:out())
		s:osc("sine", a.frequency):to(envelope)
		s:osc("triangle", a.frequency * 2):to(s:gain(0.35)):to(envelope)
	end,
}

-- Что-то далеко: запись сквозь даль — глухо, в стороне и больше эхом, чем напрямую.
local FAR = {
	graph = function(s)
		local a = s.args
		local source = s:sample(a.name)
		source.rate:set(a.rate)
		local muffle = s:filter("lowpass", a.muffle, 0.7)
		local panner = s:pan(a.pan)
		source:to(muffle):to(panner)
		panner:to(s:gain(a.dry)):to(s:out())
		panner:to(s:gain(a.level)):to(a.reverb)
	end,
}

local bed = nil
local next = dsp.random(math.floor(os.time() % 100000))
local function between(range: { number }): number
	return range[1] + next() * (range[2] - range[1])
end

local time, sinceStep = 0, STEP
local chord, chordAt, noteAt, distantAt, pulseAt = 1, 0, 0, 0, 0
local threat, battle = 0, 0
local biomes = { 0.25, 0.25, 0.25, 0.25 }
local triumphs: number? = nil
local brightUntil, fanfare = -math.huge, false
local gust = { wander(1), wander(2) }
local howlSwell, howlPitch, howlPan = { wander(10), wander(11) }, { wander(20), wander(21) }, { wander(30), wander(31) }

local function note(c, frequency: number, at: number, rise: number, hold: number, fade: number, level: number, color, into)
	c.audio:voice(NOTE, { into = into or bed.nodes.padFilter, at = at, length = rise + hold + fade + 0.1, args = { frequency = frequency, rise = rise, hold = hold, fade = fade, level = level, color = color } })
end

local function beat(c, frequency: number, at: number, level: number)
	c.audio:voice(BEAT, { into = bed.nodes.pulseFilter, at = at, length = 1, args = { frequency = frequency, level = level } })
end

local function far(c, name: string, level: number)
	c.audio:voice(FAR, {
		bus = "world",
		length = 7,
		args = {
			name = name,
			rate = 0.85 + next() * 0.3,
			muffle = if name == "thunder" then 400 else 1200 + next() * 1500,
			pan = (next() * 2 - 1) * 0.8,
			dry = level * (if name == "thunder" then 0.8 else 0.3),
			level = level,
			reverb = bed.nodes.reverb,
		},
	})
end

local PLAIN = { sub = 0, bell = 0, grit = 0 }

return {
	update = function(c)
		if not c.audio then
			return
		end
		local seconds = c.dt
		local now = c.audio.now
		if not bed then
			bed = c.audio:voice(BED, { bus = "world" })
			if not bed then
				return
			end
			chordAt, noteAt, distantAt, pulseAt = now, now + 1, now + between(DISTANT_GAP), now
			note(c, midi(CHORDS[1][1]), now + 0.5, 6, CHORD_TIME - 6, 8, 0.8, PLAIN)
		end
		time += seconds
		sinceStep += seconds
		if sinceStep < STEP then
			return
		end
		local elapsed = sinceStep
		sinceStep = 0

		-- Обстановка: погода, высота камеры, биом под ней. Тревога и бой — пока нули.
		local a = c.atmosphere
		local windVector = a.wind or { x = 0, y = 0 }
		local wind = clamp01(math.sqrt(windVector.x ^ 2 + windVector.y ^ 2) / STRONG_WIND)
		local precipitation = clamp01(a.precipitation or 0)
		local light = clamp01(a.light or 1)
		local altitude = clamp01(math.log(MAX_ZOOM / c.camera.zoom) / math.log(MAX_ZOOM / MIN_ZOOM))
		threat = ease(threat, 0, elapsed, EASE.threat)
		battle = ease(battle, 0, elapsed, EASE.battle)
		local _, here = c:terrain(c.camera.x, c.camera.y)
		for i = 1, 4 do
			biomes[i] = ease(biomes[i], if here == i - 1 then 1 else 0, elapsed, EASE.biome)
		end
		local erg, salt, red, marsh = biomes[1], biomes[2], biomes[3], biomes[4]
		local color = { sub = erg, bell = salt, grit = red }
		local successes = c.shared.triumphs or 0
		if triumphs == nil then
			triumphs = successes
		elseif successes > triumphs then
			triumphs = successes
			brightUntil = now + TRIUMPH_SECONDS
			fanfare = true
		end
		local n = bed.nodes

		-- Ветер дует всегда. Порыв — два медленных колебания разом.
		local strength = 0.3 + 0.7 * math.max(wind, precipitation)
		local gusting = clamp01(0.5 + 0.35 * gust[1](time / 7) + 0.25 * gust[2](time / 2.3))
		local blow = WIND_LEVEL * (0.4 + 0.6 * strength) * (0.6 + 0.8 * gusting) * (0.75 + 0.5 * altitude)
		n.windGain.gain:glide(blow, 0.3)
		n.windFilter.frequency:glide(200 + (500 + 400 * altitude) * strength * (0.5 + gusting), 0.3)

		-- Гулы накатывают и уходят; в сильный ветер чаще и громче, у земли слышнее.
		for i, howl in n.howls do
			local spec = HOWLS[i]
			local swell = clamp01(howlSwell[i](time / 9) + 0.15 * strength) ^ 1.5
			local level = HOWL_LEVELS[i] * swell * (0.25 + 0.75 * strength) * (1 - 0.4 * altitude)
			howl.level.gain:glide(level, 0.5)
			howl.band.frequency:glide(spec.frequency * (1 + spec.drift * howlPitch[i](time / 5) + 0.15 * gusting), 0.5)
			howl.panner.pan:glide(0.7 * howlPan[i](time / 13), 0.5)
		end

		n.hissGain.gain:glide(HISS_LEVEL * precipitation ^ 1.2 * (0.7 + 0.6 * gusting), 0.4)

		-- Подложка: днём светлее, ночью темнее и чуть громче; в бурю отступает за ветер. Солончаки звонче, топи глуше.
		local open = (1 + 0.5 * salt) * (1 - 0.45 * marsh) * (1 + 0.3 * battle)
		n.padFilter.frequency:glide((450 + 900 * light * (1 - 0.5 * precipitation)) * open, 1)
		n.padGain.gain:glide(PAD_LEVEL * (1 + 0.4 * (1 - light)) * (1 - 0.5 * precipitation) * (1 + 0.3 * threat + 0.25 * battle), 1)
		n.padDry.gain:glide(1 - 0.5 * marsh, 1)
		n.padWet.gain:glide(1 + 0.6 * marsh, 1)

		n.droneGain.gain:glide(DRONE_LEVEL * battle ^ 1.5, 1)
		n.droneFilter.frequency:glide(150 + 350 * battle, 1)

		-- Ноты подложки планируются чуть вперёд: точное время — у звука, не у кадров.
		local ahead = now + 0.5
		if ahead >= chordAt + CHORD_TIME then
			chordAt += CHORD_TIME
			if chordAt + CHORD_TIME < now then
				chordAt = now
			end
			chord = chord % #CHORDS + 1
			note(c, midi(CHORDS[chord][1]), math.max(now, chordAt), 6, CHORD_TIME - 6, 8, 0.8, { sub = color.sub, bell = 0, grit = color.grit })
			for _, drone in n.drones do
				drone.frequency:target(midi(CHORDS[chord][1]), math.max(now, chordAt), 2)
			end
		end
		local bass = CHORDS[chord][1]
		if ahead >= noteAt then
			noteAt = math.max(noteAt, now)
			if fanfare then
				-- Успех: мажорное трезвучие от баса аккорда, нота за нотой вверх, звонко.
				fanfare = false
				for i, step in { 24, 28, 31, 36 } do
					local k = i - 1
					note(c, midi(bass + step), noteAt + k * 0.7, 0.8, 1 + (3 - k) * 0.5, 5, 0.55, { sub = color.sub, bell = math.max(0.6, salt), grit = color.grit })
				end
				noteAt += 4
			else
				-- Светлые аккорды после успеха: малая терция над басом становится большой.
				local notes = {}
				for i = 2, #CHORDS[chord] do
					local pitch = CHORDS[chord][i]
					table.insert(notes, if now < brightUntil and (pitch - bass) % 12 == 3 then pitch + 1 else pitch)
				end
				local pitch = notes[math.floor(next() * #notes) + 1]
				if next() < 0.35 * math.max(threat, battle) then
					pitch = bass + 25
				elseif next() < 0.4 * (1 - light) then
					pitch -= 12
				end
				local urgent = 1 - 0.6 * battle
				note(c, midi(pitch), noteAt, between({ 2.5, 5 }) * urgent, between({ 1, 4 }) * urgent, between({ 4, 7 }) * (1 - 0.4 * battle), 0.35 + next() * 0.3, color)
				noteAt += between(NOTE_GAP) * (1 + 0.3 * (1 - light)) * (1 - 0.2 * threat) * (1 - 0.45 * battle)
			end
		end

		-- Пульс: слышен, пока есть тревога или бой.
		local pulseLevel = math.max(0.6 * threat, battle)
		if pulseLevel < 0.03 then
			pulseAt = math.max(pulseAt, now)
		elseif ahead >= pulseAt then
			pulseAt = math.max(pulseAt, now)
			local level = PULSE_LEVEL * pulseLevel
			beat(c, midi(bass), pulseAt, level)
			beat(c, midi(bass), pulseAt + PULSE_ECHO, level * PULSE_ECHO_LEVEL)
			pulseAt += PULSE_BEAT[1] + (PULSE_BEAT[2] - PULSE_BEAT[1]) * battle
		end

		-- Вдалеке: в бурю — чаще гром, иначе скрип или лязг. С высоты земля дальше и тише.
		if now >= distantAt then
			local name = if next() < precipitation * 0.8 then "thunder" elseif next() < 0.55 - 0.35 * math.max(battle, 0.6 * red) then "creak" else "clank"
			far(c, name, DISTANT_LEVEL * (0.5 + 0.5 * next()) * (1 - 0.5 * altitude) * (if name == "thunder" then 0.7 + precipitation else 1))
			distantAt = now + between(DISTANT_GAP) * (1 - 0.4 * precipitation) * (1 - 0.5 * battle)
		end
	end,
}
