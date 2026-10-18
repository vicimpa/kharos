--!strict
-- Музыка главного меню — перенос packages/client/src/audio/music.ts: медленные минорные аккорды под эхо и неспешная
-- мелодия поверх. Аккорды — ре минор, си-бемоль, до, ля минор, как у подложки игры (audio/ambience): музыка меню и
-- фон игры одного рода. Вступает за FADE_IN секунд; витрина меняет мир под меню, а звук и музыка продолжаются.

local dsp = require("lib/dsp")

-- Громкость музыки при полной громкости игры (LEVEL). В TS музыка меню шла мимо общей громкости 0,6 (MASTER в
-- audio.ts), здесь — через неё: поэтому делим.
local LEVEL = 0.32 / 0.6
local FADE_IN = 5
-- Сколько эха в музыке: она звучит как издалека, над пустой землёй.
local WET = 0.7
-- Аккорды: номера MIDI, первая — бас, остальные — пэд; сколько секунд звучит аккорд.
local CHORDS = {
	{ 38, 57, 62, 65, 69 },
	{ 34, 53, 58, 62, 65 },
	{ 36, 55, 60, 64, 67 },
	{ 33, 52, 57, 60, 64 },
}
local CHORD_TIME = 12
-- Мелодия — ре минорная пентатоника в верхней октаве: любая нота ложится на любой аккорд. Паузы между нотами — от и
-- до; иногда она молчит дольше.
local MELODY = { 74, 77, 79, 81, 84, 86 }
local MELODY_GAP = { 1.2, 3 }
-- Насколько вперёд планируются ноты и как часто, в секундах: точное время — у звука, а не у кадра.
local AHEAD = 0.6
local EVERY = 0.2

local function midi(note: number): number
	return 440 * 2 ^ ((note - 69) / 12)
end

-- Основа: громкость с вступлением, фильтр, сухой звук и эхо.
local BUS = {
	graph = function(s)
		local out = s:out()
		out.gain:set(0, s.at)
		out.gain:ramp(LEVEL, s.at + FADE_IN)
		local reverb = s:reverb("reverb:music")
		reverb:to(s:gain(WET)):to(out)
		local dry = s:gain(1 - WET * 0.5)
		dry:to(out)
		local bus = s:filter("lowpass", 2400, 0.7)
		bus:to(dry)
		bus:to(reverb)
		return { bus = bus }
	end,
}

-- Нота: всплывает за rise, держится hold, тает за fade. Две чуть разные волны — звук тёплый; pan — сторона.
local NOTE = {
	graph = function(s)
		local a = s.args
		local at = s.at
		local envelope = s:gain(0)
		envelope.gain:set(0, at)
		envelope.gain:ramp(a.volume, at + a.rise)
		envelope.gain:set(a.volume, at + a.rise + a.hold)
		envelope.gain:exp(0.0001, at + a.rise + a.hold + a.fade)
		envelope:to(s:pan(a.pan)):to(s:out())
		local voices = {
			{ wave = if a.bright then "triangle" else "sine", detune = -5, level = 1 },
			{ wave = "triangle", detune = 6, level = if a.bright then 0.25 else 0.4 },
		}
		for _, voice in voices do
			local oscillator = s:osc(voice.wave, a.frequency)
			oscillator.detune:set(voice.detune)
			oscillator:to(s:gain(voice.level)):to(envelope)
		end
	end,
}

local bus = nil
local next = dsp.random(math.floor(os.time() % 100000))
local function between(range: { number }): number
	return range[1] + next() * (range[2] - range[1])
end
local chord, chordAt, melodyAt, last, since = 0, 0, 0, 0, EVERY

local function note(c, frequency: number, at: number, rise: number, hold: number, fade: number, volume: number, pan: number, bright: boolean)
	c.audio:voice(NOTE, { into = bus.nodes.bus, at = at, length = rise + hold + fade + 0.1, args = { frequency = frequency, rise = rise, hold = hold, fade = fade, volume = volume, pan = pan, bright = bright } })
end

return {
	update = function(c)
		if not c.audio then
			return
		end
		local now = c.audio.now
		if not bus then
			bus = c.audio:voice(BUS, { bus = "music" })
			if not bus then
				return
			end
			chord, chordAt, last = 0, now + 0.3, 0
			melodyAt = chordAt + 4
		end
		since += c.dt
		if since < EVERY then
			return
		end
		since = 0
		local ahead = now + AHEAD
		-- Окно стояло — не догоняем упущенное, а продолжаем с этого мига.
		if chordAt < now - CHORD_TIME then
			chordAt = now
		end
		while chordAt <= ahead do
			chord = chord % #CHORDS + 1
			local notes = CHORDS[chord]
			local bass = notes[1]
			note(c, midi(bass), chordAt, 2, CHORD_TIME - 2, 4, 0.22, 0, false)
			note(c, midi(bass + 12), chordAt, 3, CHORD_TIME - 3, 4, 0.06, 0, false)
			for i = 2, #notes do
				local k = i - 2
				note(c, midi(notes[i]), chordAt + k * 0.35, 3, CHORD_TIME - 4, 5, 0.05, k / (#notes - 2) * 1.2 - 0.6, false)
			end
			chordAt += CHORD_TIME
		end
		if melodyAt < now - 5 then
			melodyAt = now
		end
		while melodyAt <= ahead do
			-- Мелодия ходит шагами, а не скачет: следующая нота — рядом с прошлой.
			last = if last == 0 then math.floor(next() * #MELODY) + 1 else math.clamp(last + math.round((next() * 2 - 1) * 2), 1, #MELODY)
			note(c, midi(MELODY[last]), melodyAt, 0.02, 0.15, between({ 1.5, 3 }), 0.07, (next() * 2 - 1) * 0.5, true)
			melodyAt += between(MELODY_GAP) * (if next() < 0.15 then 3 else 1)
		end
	end,
}
