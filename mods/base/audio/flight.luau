--!strict
-- Ветер полёта: камера несётся над картой — в ушах свистит поток. Чем быстрее, тем громче и выше свист, поток дрожит и
-- рвётся. Скорость камеры: с FLIGHT_START тайлов в секунду начинается, на FLIGHT_FULL свистит во всю силу, между ними —
-- по логарифму.

local LEVEL = 0.9
local RISE = 0.08
local FALL = 0.35
local BAND_LOW = 450
local BAND_HIGH = 4200
local FLUTTER_LOW = 5
local FLUTTER_HIGH = 13
local FLIGHT_START = 20
local FLIGHT_FULL = 500

local FLIGHT = {
	graph = function(s)
		local bus = s:gain(0)
		bus:to(s:out())
		-- Свист — розовый шум через полосу.
		local rush = s:sample("noise:pink", { loop = true, offset = 1.3 })
		local band = s:filter("lowpass", BAND_LOW, 1.5)
		local rushGain = s:gain(1)
		rush:to(s:filter("highpass", 160, 0.7)):to(band):to(rushGain):to(bus)
		-- Гул — тело потока: бурый шум, только низы.
		s:sample("noise:brown", { loop = true, offset = 2.7 }):to(s:filter("lowpass", 240, 0.7)):to(s:gain(0.9)):to(bus)
		-- Трепет — свист дрожит часто и неглубоко; раскачка — весь ветер медленно накатывает.
		local flutter = s:osc("sine", FLUTTER_LOW)
		local flutterDepth = s:gain(0)
		flutter:to(flutterDepth):to(rushGain.gain)
		local sway = s:osc("sine", 0.6)
		local swayDepth = s:gain(0)
		sway:to(swayDepth):to(bus.gain)
		return { bus = bus, band = band, rush = rush, flutter = flutter, flutterDepth = flutterDepth, swayDepth = swayDepth }
	end,
	update = function(n, level)
		-- Тихий ветер слышен еле-еле, громким становится только быстрый.
		local loudness = LEVEL * level ^ 1.5
		n.bus.gain:glide(loudness, 0.03)
		n.swayDepth.gain:glide(loudness * 0.2, 0.03)
		n.band.frequency:glide(BAND_LOW * (BAND_HIGH / BAND_LOW) ^ level, 0.05)
		n.rush.rate:glide(0.8 + 0.5 * level, 0.05)
		n.flutter.frequency:glide(FLUTTER_LOW + (FLUTTER_HIGH - FLUTTER_LOW) * level, 0.05)
		n.flutterDepth.gain:glide(0.3 * level, 0.05)
	end,
}

local voice = nil
local level = 0
local last: { x: number, y: number }? = nil

return {
	update = function(c)
		if not c.audio then
			return
		end
		if not voice then
			voice = c.audio:voice(FLIGHT, { bus = "world" })
			if not voice then
				return
			end
			voice:place(1, 0)
		end
		local cam = c.camera
		local seconds = math.max(c.dt, 1e-3)
		local speed = 0
		if last then
			speed = math.sqrt((cam.x - last.x) ^ 2 + (cam.y - last.y) ^ 2) / seconds
		end
		last = { x = cam.x, y = cam.y }
		local target = math.clamp(math.log(math.max(speed, 1e-6) / FLIGHT_START) / math.log(FLIGHT_FULL / FLIGHT_START), 0, 1)
		level += (target - level) * (1 - math.exp(-seconds / (if target > level then RISE else FALL)))
		voice:set(level)
	end,
}
