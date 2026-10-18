--!strict
-- Колея и отпечатки ног. Наземный юнит оставляет точку пути, пройдя STEP тайла или повернув на TURN; соседняя точка,
-- если она рядом, соединяется с новой колеёй под каждым колесом (look.traces.sides) или отпечатками ступней через
-- полшага. Колея — тень вдавленного грунта: на скале почти не видна, на болоте и горах её нет; живёт LIFE секунд и с
-- четверти срока растворяется пиксель за пикселем.

local STEP = 0.5
local TURN = 0.35
-- Точки пути дальше этого друг от друга — не шаг, а скачок: колея между ними не тянется.
local LINK = 1.5
local LIFE = 90
-- Точек колеи на тайл разом: в толпе колея не густеет бесконечно (DENSITY.track).
local PER_TILE = 2
-- Через сколько тайлов пути пехотинец оставляет отпечаток ступни и какой он длины.
local STEP_LENGTH = 0.3
local FOOTPRINT = 0.1

local COLOR = { 0.16, 0.11, 0.06 }
-- Непрозрачность по местности: болото, песок, скала, гора.
local OPACITY = { [0] = 0, 0.4, 0.18, 0 }
-- Какая доля пикселей колеи закрашена: колея зернистая, как продавленный песок.
local DENSITY = 0.8

local sin, cos, abs, floor, atan2 = math.sin, math.cos, math.abs, math.floor, math.atan2

type Point = { x: number, y: number, facing: number, foot: number }

-- Где каждый юнит оставил последнюю точку и какая точка легла в колею последней.
local walkers: { [number]: Point } = {}
local paths: { [number]: Point } = {}
-- Точек колеи по тайлам и когда они уйдут — по порядку.
local counts: { [number]: number } = {}
local leaving: { { time: number, key: number } } = {}
local head = 1

local function angleBetween(a: number, b: number): number
	return atan2(sin(a - b), cos(a - b))
end

local function tileKey(x: number, y: number): number
	return (floor(x) + 32768) * 65536 + floor(y) + 32768
end

local function opacityAt(c, x: number, y: number): number
	local kind = c:terrain(x, y)
	return if kind then OPACITY[kind] else OPACITY[1]
end

local function lay(c, fromX: number, fromY: number, toX: number, toY: number, width: number, opacity: number)
	c:decal({ from = { fromX, fromY }, to = { toX, toY }, width = width, color = COLOR, opacity = opacity, density = DENSITY, life = LIFE })
end

-- Колея или шаги от точки пути from до to одного юнита.
local function walk(c, from: Point, to: Point, trace)
	local width = trace.width / 16
	if not trace.legs then
		for _, side in trace.sides do
			local fromX, fromY = from.x - sin(from.facing) / 16 * side, from.y + cos(from.facing) / 16 * side
			local toX, toY = to.x - sin(to.facing) / 16 * side, to.y + cos(to.facing) / 16 * side
			lay(c, fromX, fromY, toX, toY, width, opacityAt(c, toX, toY))
		end
		return
	end
	-- Ноги шагают по очереди: отпечатки ступней вдоль хода, через полшага, то одной, то другой.
	local length = math.sqrt((to.x - from.x) ^ 2 + (to.y - from.y) ^ 2)
	local alongX, alongY = cos(to.facing) * FOOTPRINT / 2, sin(to.facing) * FOOTPRINT / 2
	local acrossX, acrossY = -sin(to.facing) / 16, cos(to.facing) / 16
	local step = 0
	while step * (STEP_LENGTH / 2) < length do
		local share = step * (STEP_LENGTH / 2) / length
		local side = trace.sides[(from.foot + step) % #trace.sides + 1]
		local x = from.x + (to.x - from.x) * share + acrossX * side
		local y = from.y + (to.y - from.y) * share + acrossY * side
		lay(c, x - alongX, y - alongY, x + alongX, y + alongY, width, opacityAt(c, x, y))
		step += 1
		to.foot = from.foot + step
	end
end

-- Занимает место под точку колеи; false — тайл полон.
local function take(x: number, y: number, now: number): boolean
	local key = tileKey(x, y)
	local count = counts[key] or 0
	if count >= PER_TILE then
		return false
	end
	counts[key] = count + 1
	table.insert(leaving, { time = now + LIFE, key = key })
	return true
end

local function release(now: number)
	while leaving[head] and leaving[head].time <= now do
		local key = leaving[head].key
		local count = (counts[key] or 1) - 1
		counts[key] = if count > 0 then count else nil
		leaving[head] = nil :: any
		head += 1
	end
	-- Ушедшие сдвигаются разом, когда их набралось много.
	if head > 4096 then
		table.move(leaving, head, head + #leaving, 1)
		for i = #leaving - head + 2, #leaving do
			leaving[i] = nil :: any
		end
		head = 1
	end
end

return {
	update = function(c)
		local now = c.clock
		release(now)
		local seen = {}
		for _, e in c:each({ "Position", "Proto" }) do
			local proto = c:proto(e)
			local trace = proto and proto.look and proto.look.traces
			if not trace then
				continue
			end
			seen[e] = true
			local position = c:get(e, "Position")
			local facing = c:get(e, "Facing")
			local angle = if facing then facing.angle else 0
			local last = walkers[e]
			if last then
				local moved = math.sqrt((position.x - last.x) ^ 2 + (position.y - last.y) ^ 2)
				if moved < 1e-3 or (moved < STEP and abs(angleBetween(angle, last.facing)) < TURN) then
					continue
				end
			end
			local point: Point = { x = position.x, y = position.y, facing = angle, foot = 0 }
			walkers[e] = point
			-- Первая точка — тоже точка: от неё колея и потянется. Скачок узнаётся по расстоянию и не соединяется.
			if not take(point.x, point.y, now) then
				continue
			end
			local before = paths[e]
			if before and math.sqrt((point.x - before.x) ^ 2 + (point.y - before.y) ^ 2) <= LINK then
				walk(c, before, point, trace)
			end
			paths[e] = point
		end
		for e in walkers do
			if not seen[e] then
				walkers[e] = nil
				paths[e] = nil
			end
		end
	end,
}
