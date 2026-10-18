--!strict
-- Моторы техники — перенос packages/client/src/game/motors.ts. Каждая машина — своя езда (lib/drive): заводится
-- стартером, разгоняется по передачам, едет, сбрасывает газ, тормозит, стоит на холостых и глохнет. Ближайшие VOICES
-- машин слышны каждая своим голосом, со своей стороны и со своими оборотами; остальные — общим голосом толпы своего
-- мотора. Мотор и тон юнита — data.motor и data.pitch его вида. Свою машину выбрали — она заводится и, пока выбрана,
-- не глохнет; глохнет только простояв.

local drive = require("lib/drive")
local motorSounds = require("sounds/motors")

local MOTORS = motorSounds.MOTORS

-- Громкость мотора вблизи: тяжёлые громче.
local LOUDNESS = { petrol = 0.3, diesel = 0.38, heavy = 0.48, rotor = 0.4, props = 0.2, jet = 0.38 }
local HANDLINGS = { petrol = drive.HANDLING.petrol, diesel = drive.HANDLING.diesel, heavy = drive.HANDLING.heavy, rotor = drive.HANDLING.air, props = drive.HANDLING.air, jet = drive.HANDLING.air }
-- Сколько машин слышно каждую своим голосом; звучащая держит голос, пока её не перекричат во столько раз.
local VOICES = 6
local KEEP = 1.4
-- За краем экрана мотор стихает на этом расстоянии, в долях полуширины экрана.
local HEARING = 0.6
-- Толпа: громкость — 1 − e^(−сумма/SATURATE), глуше и тише своих голосов.
local SATURATE = 3
local CROWD_LEVEL = 0.6
local CROWD_CLARITY = 0.4
-- Громкость стартера и тормоза против мотора; чаще EVENT_GAP они не звучат.
local START_VOLUME = 0.5
local BRAKE_VOLUME = 0.7
local EVENT_GAP = 0.25
-- Медленнее STILL юнит стоит, если не сдвигается дольше STOP_HOLD; быстрее JUMP — перенос, а не ход.
local STILL = 0.06
local STOP_HOLD = 0.3
local JUMP = 2.2
-- Длина тика хоста.
local STEP = 0.05

local cars = {}
local crowds = {}
local clock = 0
local last = {}

local function wrap(angle: number): number
	return angle - math.pi * 2 * math.floor(angle / (math.pi * 2) + 0.5)
end

local function event(c, kind: string, name: string, volume: number, side: number)
	if volume <= 0.01 or clock - (last[kind] or -math.huge) < EVENT_GAP then
		return
	end
	last[kind] = clock
	c.audio:play(name, volume, side * 0.8, 1 + (c.audio:random() * 2 - 1) * 0.08)
end

local function release(car)
	if car.voice then
		car.voice:release(0.25)
		car.voice = nil
	end
end

local function voiceOf(c, motor: string, squeal: boolean)
	local spec = MOTORS[motor]
	local running = spec.running
	local scrape = if squeal and running then (if running == "clatter" then "squeal" else "screech") else nil
	return c.audio:voice("motors", { bus = "world", args = { motor = motor, running = running, squeal = scrape } })
end

-- Новый замер хода: юнит сдвинулся на тике. Скорость — доля его полной, поворот — доля наибыстрейшего.
local function measure(car, x: number, y: number, facing: number, tick: number, seconds: number)
	if tick == car.tick then
		return
	end
	local elapsed = (tick - car.tick) * STEP
	local speed = math.sqrt((x - car.x) ^ 2 + (y - car.y) ^ 2) / elapsed / car.speed
	local turn = math.abs(wrap(facing - car.facing)) / elapsed / car.turnRate
	car.x, car.y, car.facing, car.tick, car.turn = x, y, facing, tick, turn
	if speed > JUMP then
		return
	end
	if speed > STILL then
		car.still = 0
		car.target = speed
	else
		car.still += math.max(elapsed, seconds)
		if car.still >= STOP_HOLD then
			car.target = 0
		end
	end
end

return {
	update = function(c)
		if not c.audio then
			return
		end
		local seconds = c.dt
		clock += seconds
		local seen = {}
		local heard = {}
		local tick = c.tick
		local selected = {}
		for _, e in c.shared.selection or {} do
			selected[e] = c:mine(e)
		end
		for _, e in c:each({ "Unit", "Position", "Facing" }) do
			local kind = c:proto(e)
			local name = kind and kind.data and kind.data.motor
			if not name or not MOTORS[name] then
				continue
			end
			-- Место и поворот — на тике, а не сглаженные: скорость считается по тикам хоста.
			local at = c:get(e, "Position")
			local facing = c:get(e, "Facing").angle
			local near = c:nearness(at.x, at.y, HEARING)
			local side = c:side(at.x)
			seen[e] = true
			local car = cars[e]
			if not car then
				local motor = MOTORS[name]
				car = {
					motor = name, drive = drive.new(not motor.start), x = at.x, y = at.y, facing = facing, tick = tick,
					target = 0, turn = 0, still = 0, speed = kind.data.speed or 1, turnRate = kind.data.turn or 1,
					pitch = (kind.data.pitch or 1) * (0.96 + ((e * 0.618034) % 1) * 0.08), voice = nil,
				}
				cars[e] = car
			end
			measure(car, at.x, at.y, facing, tick, seconds)
			local motor = MOTORS[name]
			local loudness = LOUDNESS[name] * near
			-- Только что выбрали — заводится.
			local held = selected[e] == true
			if held and not car.held and drive.wake(car.drive, motor) then
				event(c, "start", motor.start, loudness * START_VOLUME, side)
			end
			car.held = held
			local happened = drive.step(car.drive, motor, HANDLINGS[name], motorSounds.START_CRANK, car.target, seconds, held)
			if happened == "start" and motor.start then
				event(c, "start", motor.start, loudness * START_VOLUME, side)
			end
			if happened == "brake" then
				event(c, "brake", "airBrake", loudness * BRAKE_VOLUME, side)
			end
			-- Заглохший слышен ещё секунду: мотор сбегает с оборотов.
			if near <= 0 or (car.drive.phase == "off" and car.drive.timer > 1) then
				release(car)
				continue
			end
			local sound = drive.sound(car.drive, motor, math.min(1, car.turn))
			sound.rate *= car.pitch
			table.insert(heard, { car = car, near = near, side = side, sound = sound, score = loudness * (0.6 + 0.4 * car.drive.throttle) * (if car.voice then KEEP else 1) })
		end
		for e, car in cars do
			if not seen[e] then
				release(car)
				cars[e] = nil
			end
		end

		-- Громче всех слышные — своими голосами, остальные — толпой.
		table.sort(heard, function(a, b)
			return a.score > b.score
		end)
		for _, crowd in crowds do
			crowd.sum, crowd.side, crowd.rate, crowd.load, crowd.running = 0, 0, 0, 0, 0
		end
		for index, entry in heard do
			local car, sound = entry.car, entry.sound
			if index <= VOICES then
				if not car.voice then
					car.voice = voiceOf(c, car.motor, MOTORS[car.motor].running ~= nil)
				end
			else
				release(car)
			end
			if car.voice then
				sound.volume = 1
				sound.clarity = entry.near
				car.voice:set(sound)
				car.voice:place(LOUDNESS[car.motor] * entry.near, entry.side * 0.8)
			elseif sound.level > 0 then
				local crowd = crowds[car.motor]
				if not crowd then
					crowd = { voice = nil, sum = 0, side = 0, rate = 0, load = 0, running = 0 }
					crowds[car.motor] = crowd
				end
				crowd.sum += entry.near
				crowd.side += entry.near * entry.side
				crowd.rate += entry.near * sound.rate
				crowd.load += entry.near * sound.load
				crowd.running += entry.near * sound.running
			end
		end
		for name, crowd in crowds do
			if crowd.sum == 0 then
				if crowd.voice then
					crowd.voice:release(0.25)
					crowd.voice = nil
				end
				continue
			end
			if not crowd.voice then
				crowd.voice = voiceOf(c, name, false)
			end
			if crowd.voice then
				local running = crowd.running / crowd.sum
				crowd.voice:set({ rate = crowd.rate / crowd.sum, load = crowd.load / crowd.sum, level = 1, running = running, runningRate = running, squeal = 0, clarity = CROWD_CLARITY })
				crowd.voice:place(LOUDNESS[name] * CROWD_LEVEL * (1 - math.exp(-crowd.sum / SATURATE)), crowd.side / crowd.sum * 0.8)
			end
		end
	end,
}
