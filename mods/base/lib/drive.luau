--!strict
-- Езда машины для звука. Хост двигает юнит сразу на полной скорости и останавливает разом, а мотор так не умеет: здесь
-- у машины своя скорость, которая догоняет настоящую, — с ней звучат разгон по передачам, ровный ход, сброс газа и
-- остановка. Постояв на холостых, мотор глохнет; выбранную машину заводят заранее (wake), а тронувшись заглохшей, она
-- заводится стартером, но звук езды есть сразу. Летающие не глохнут.

local drive = {}

-- Как машина разгоняется и тормозит (доля полной скорости в секунду) и где кончается каждая передача.
drive.HANDLING = {
	petrol = { accel = 2.2, brake = 2.5, gears = { 0.22, 0.45, 0.72, 1.6 } },
	diesel = { accel = 1.4, brake = 1.8, gears = { 0.3, 0.6, 1.6 } },
	heavy = { accel = 1.2, brake = 1.6, gears = { 0.35, 0.7, 1.4 } },
	air = { accel = 0.6, brake = 0.8, gears = {} },
}

-- Столько секунд мотор стоит на холостых, а потом глохнет.
drive.IDLE_HOLD = 6
local SHIFT = 0.1
local SHIFT_DROP = 0.35
local STILL = 0.06
local BRAKE_FROM = 0.35
local SPOOL = 2.5
local SCREECH_TURN = 0.5
local SCREECH_SPEED = 0.5
local RPM_LAG = 0.12
local THROTTLE_LAG = 0.08

-- Новая машина: наземная заглушена давно, летающая только взлетает.
function drive.new(air: boolean)
	return { phase = if air then "run" else "off", speed = 0, rpm = 0, throttle = 0, gear = 0, shift = 0, timer = if air then 0 else math.huge, spool = 0 }
end

local function follow(value: number, target: number, seconds: number, lag: number): number
	return value + (target - value) * (1 - math.exp(-seconds / lag))
end

-- Завести заглушенную машину заранее — её выбрали: стартер крутит, и мотор встаёт на холостые. true — завелась
-- сейчас (звучит стартер).
function drive.wake(d, motor): boolean
	if not motor.start or d.phase ~= "off" then
		return false
	end
	d.phase = "crank"
	d.timer = 0
	return true
end

-- Мотор схватил: с перегазовкой.
local function catch(d)
	d.phase = "run"
	d.timer = 0
	d.rpm = 0.6
	d.throttle = 1
end

-- Шаг езды на seconds: target — с какой долей полной скорости юнит едет на самом деле; hold — не глохнуть (машину
-- держат выбранной). Возвращает "start" или "brake", если это случилось.
function drive.step(d, motor, handling, crank: { [string]: number }, target: number, seconds: number, hold: boolean?): string?
	local event = nil
	local air = not motor.start
	local moving = target > STILL
	d.timer += seconds
	if air then
		d.spool = math.min(1, d.spool + seconds / SPOOL)
	end
	if d.phase == "off" then
		if not moving then
			return nil
		end
		-- Машина уже едет: стартер звучит, но мотор схватывает сразу — езда без молчания.
		catch(d)
		event = "start"
	elseif d.phase == "crank" then
		-- Стартер докрутит, а тронулась — мотор схватывает сразу.
		if not moving and d.timer < crank[motor.start] then
			return nil
		end
		catch(d)
	end

	local before = d.speed
	d.shift = math.max(0, d.shift - seconds)
	local wanted = if moving then target else 0
	if wanted > d.speed then
		if d.shift == 0 then
			d.speed = math.min(wanted, d.speed + handling.accel * seconds)
		end
	else
		d.speed = math.max(wanted, d.speed - handling.brake * seconds)
	end
	if motor.brake and not moving and before >= BRAKE_FROM and d.speed < BRAKE_FROM then
		event = "brake"
	end

	-- Газ: разгон — в пол, ровный ход — чуть, сброс — отпущен. На переключении газ сброшен.
	local accelerating = wanted > d.speed + 0.02
	local cruising = moving and not accelerating and wanted >= d.speed - 0.02
	local throttle = if accelerating then 1 elseif cruising then 0.35 + 0.25 * math.min(1, d.speed) else 0
	if d.shift > 0 then
		throttle = 0.1
	end

	local rpm
	if air then
		rpm = math.min(1, d.speed * 0.75 + throttle * 0.25)
	else
		-- Передача — по скорости: вверх на пределе своей, вниз с запасом.
		local gears = handling.gears
		while d.gear < #gears - 1 and d.speed >= gears[d.gear + 1] do
			d.gear += 1
			if accelerating then
				d.shift = SHIFT
				d.rpm = math.min(d.rpm, SHIFT_DROP + 0.1)
				throttle = 0.1
			end
		end
		while d.gear > 0 and d.speed < gears[d.gear] * 0.8 do
			d.gear -= 1
		end
		local low = if d.gear > 0 then gears[d.gear] else 0
		local share = math.clamp((d.speed - low) / (gears[d.gear + 1] - low), 0, 1)
		rpm = if d.gear > 0 then SHIFT_DROP + (1 - SHIFT_DROP) * share else share
		-- Стоя, мотор держит холостые; на газу с места — чуть подвывает.
		if d.speed < STILL then
			rpm = if accelerating then 0.15 else 0
		end
	end
	d.rpm = follow(d.rpm, rpm, seconds, if d.shift > 0 then RPM_LAG / 2 else RPM_LAG)
	d.throttle = follow(d.throttle, throttle, seconds, THROTTLE_LAG)

	if not air then
		if moving or d.speed > STILL or hold then
			d.timer = 0
		elseif d.timer >= drive.IDLE_HOLD then
			d.phase = "off"
			d.gear = 0
			d.timer = 0
		end
	end
	return event
end

-- Как звучит мотор при этой езде; volume, pan и clarity ставит тот, кто знает, где машина. turn — доля поворота.
function drive.sound(d, motor, turn: number)
	local air = not motor.start
	local running = d.phase == "run"
	-- Заглохший мотор, сбегая с оборотов, опускается ниже холостых.
	local rate = if running then 1 + (motor.revs - 1) * d.rpm else 0.6
	local squeal = 0
	if running then
		if motor.running == "clatter" then
			squeal = math.min(1, turn) * math.max(0, 1 - d.speed * 3)
		elseif motor.running == "roll" then
			squeal = math.clamp((turn - SCREECH_TURN) / (1 - SCREECH_TURN), 0, 1) * math.max(0, d.speed - SCREECH_SPEED) / (1 - SCREECH_SPEED)
		end
	end
	return {
		rate = if air then rate * (0.6 + 0.4 * d.spool) else rate,
		load = if running then d.throttle else 0,
		level = if running then (if air then 0.4 + 0.6 * d.spool else 0.55 + 0.45 * d.throttle) else 0,
		running = math.min(1, d.speed * 1.2),
		runningRate = d.speed,
		squeal = squeal,
	}
end

return drive
