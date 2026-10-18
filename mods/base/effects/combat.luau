--!strict
-- Подача боя — перенос combatPass.ts: снаряды, лучи, разряды и струи огня, вспышки у ствола, взрывы и дым после
-- них, огни в темноте и полоски прочности над повреждёнными юнитами. Выстрелы (Shot) и взрывы (Blast) — сущности
-- мира от системы движка fight; клубы дыма живут только на экране. Светящееся (c.glow) складывается с картинкой,
-- остальное ложится поверх (c.draw). Купола щитов — тоже здесь. Ядерные ракеты придут со своей механикой.

local noise = require("lib/noise").of

local combat = {}

local function rgb(r: number, g: number, b: number): number
	return math.round(r * 255) * 0x10000 + math.round(g * 255) * 0x100 + math.round(b * 255)
end

combat.data = {
	-- Во сколько раз картинка взрыва шире его радиуса; пятно света — шире в BLAST_LIGHT раз, ореол — вдвое уже.
	blastScale = 2.6,
	blastLight = 5,
	-- Длина следа пули и корпуса ракеты в тайлах.
	bulletTail = 0.45,
	rocketBody = 0.3,
	-- Больше клубов разом не бывает: самые старые уступают место новым.
	puffLimit = 700,
	-- Через сколько тайлов пути ракета и ядро оставляют за собой клуб дыма.
	rocketSmokeStep = 0.22,
	shellSmokeStep = 0.4,
	-- Какую долю скорости ветра набирает дым и с какой скоростью он всплывает, в тайлах в секунду.
	smokeWind = 0.12,
	smokeRise = 0.25,
	-- Какая доля яркости остаётся у дыма в полной темноте.
	smokeNight = 0.75,
	-- Как высоко поднимается ракета в верхней точке дуги — доля от дальности выстрела.
	rocketArc = 0.3,
	-- Излом разряда: через сколько тайлов ломается линия, насколько отклоняется и сколько раз в секунду меняется.
	arcStep = 0.45,
	arcSway = 0.28,
	arcRate = 30,
	-- Размеры вспышек, лучей и снарядов заданы в точках: точка — пиксель экрана при таком масштабе.
	effectZoom = 32,
	-- Сколько тиков после выстрела у ствола видна вспышка.
	muzzleTicks = 1,
	-- Языки огнемёта: сколько пятен вдоль струи.
	flameTongues = 6,
	-- Высота полоски прочности в пикселях экрана и её отступ над юнитом в тайлах.
	barHeight = 3,
	barGap = 0.25,
	-- Купол щита: из скольких отрезков кольца и сколько секунд вспыхивает от погашенного попадания (DOME_SEGMENTS,
	-- DOME_FLASH).
	domeSegments = 64,
	domeFlash = 0.6,
}

local BULLET = rgb(1, 0.9, 0.55)
local TRACER = rgb(0.75, 0.4, 0.05)
local ROCKET = rgb(0.85, 0.87, 0.9)
local FLAME = rgb(1, 0.6, 0.2)
local SHELL = rgb(0.12, 0.12, 0.14)
local LASER = rgb(1, 0.15, 0.3)
local EMBER = rgb(1, 0.35, 0.08)
local SPARK = rgb(0.3, 0.6, 1)
local CORE = rgb(1, 1, 1)
local DOME = rgb(0.35, 0.7, 1)
local BAR_BACK = rgb(0.03, 0.05, 0.08)
local BAR_GOOD = rgb(0.45, 0.9, 0.55)
local BAR_BAD = rgb(1, 0.35, 0.25)

type Puff = {
	x: number,
	y: number,
	speedX: number,
	speedY: number,
	age: number,
	life: number,
	size: number,
	grow: number,
	shade: number,
	level: number,
	kind: number,
}

local puffs: { Puff } = {}
-- Где снаряд оставил последний клуб дыма; по этому же списку видно, какие выстрелы и взрывы уже дымили.
local trails: { [number]: { x: number, y: number } } = {}
-- Мир, к которому относятся клубы и следы: начали заново — прежние из другого мира.
local lastTick = -1

local function spread(size: number): number
	return (math.random() - 0.5) * size
end

local function puff(x: number, y: number, size: number, life: number, shade: number, level: number, speedX: number?, speedY: number?)
	if #puffs >= combat.data.puffLimit then
		table.remove(puffs, 1)
	end
	table.insert(puffs, {
		x = x,
		y = y,
		speedX = speedX or 0,
		speedY = speedY or 0,
		age = 0,
		life = life * (0.75 + math.random() * 0.5),
		size = size,
		grow = 1.2 + math.random(),
		shade = shade,
		level = level,
		kind = math.floor(math.random() * 3),
	})
end

-- Доля отпущенного срока, которую выстрел или взрыв уже прожил, с учётом доли тика.
local function ageOf(thing, alpha: number): number
	return math.min(1, (thing.age + alpha) / math.max(1, thing.life))
end

-- Как высоко над землёй ракета в точке (x, y), в тайлах: она одна летит по дуге, поверх стен.
local function arcLift(shot, x: number, y: number): number
	local flown = math.sqrt((x - shot.fromX) ^ 2 + (y - shot.fromY) ^ 2)
	local left = math.sqrt((shot.toX - x) ^ 2 + (shot.toY - y) ^ 2)
	local reach = flown + left
	return if reach > 0 then math.sin(math.pi * (flown / reach)) * reach * combat.data.rocketArc else 0
end

-- Новые клубы от выстрелов и взрывов этого кадра.
local function emitSmoke(c, shots, blasts)
	local d = combat.data
	local alive = {}
	for _, blast in blasts do
		alive[blast.entity] = true
		if trails[blast.entity] then
			continue
		end
		trails[blast.entity] = { x = blast.x, y = blast.y }
		-- После взрыва остаётся тёмный дым: чем больше взрыв, тем его больше и тем дольше он висит.
		local size = blast.size
		for _ = 1, math.round(3 + size * 4) do
			puff(blast.x + spread(size), blast.y - blast.lift + spread(size), size * (0.5 + math.random() * 0.4), 1.4 + size, 0.3, 0.75, spread(0.5), spread(0.5))
		end
	end
	for _, shot in shots do
		alive[shot.entity] = true
		local weapon = shot.weapon
		local last = trails[shot.entity]
		if not last then
			trails[shot.entity] = { x = shot.fromX, y = shot.fromY }
			if not weapon.speed then
				-- Лазер и разряд дымят там, куда попали.
				puff(shot.toX, shot.toY, 0.3, 0.7, 0.45, 0.5, spread(0.3), spread(0.3))
				continue
			end
			-- Дым у ствола летит вслед за снарядом: у пули — облачко, у ядра и ракеты — целое облако.
			local reach = math.sqrt((shot.toX - shot.fromX) ^ 2 + (shot.toY - shot.fromY) ^ 2)
			if reach == 0 then
				reach = 1
			end
			local headingX, headingY = (shot.toX - shot.fromX) / reach, (shot.toY - shot.fromY) / reach
			local heavy = weapon.shot ~= "bullet"
			for _ = 1, if heavy then 5 else 1 do
				local push = if heavy then 0.6 + math.random() * 1.6 else 0.8
				puff(shot.fromX, shot.fromY, if heavy then 0.4 else 0.2, if heavy then 1.1 else 0.4, 0.55, if heavy then 0.7 else 0.45, headingX * push + spread(0.6), headingY * push + spread(0.6))
			end
			continue
		end
		if weapon.shot ~= "rocket" and weapon.shot ~= "shell" then
			continue
		end
		local rocket = weapon.shot == "rocket"
		local step = if rocket then d.rocketSmokeStep else d.shellSmokeStep
		local x, y = shot.x, shot.y
		local distance = math.sqrt((x - last.x) ^ 2 + (y - last.y) ^ 2)
		local count = math.min(16, math.floor(distance / step))
		for i = 1, count do
			local share = (i * step) / distance
			local atX, atY = last.x + (x - last.x) * share, last.y + (y - last.y) * share
			-- Дым ракеты остаётся в воздухе, на высоте её дуги; ядро летит прямо и низко.
			if rocket then
				puff(atX + spread(0.08), atY - arcLift(shot, atX, atY) + spread(0.08), 0.32, 1.3, 0.55, 0.75, spread(0.25), spread(0.25))
			else
				puff(atX, atY, 0.18, 0.7, 0.5, 0.55, spread(0.15), spread(0.15))
			end
		end
		if count > 0 then
			local share = (count * step) / distance
			last.x += (x - last.x) * share
			last.y += (y - last.y) * share
		end
	end
	for entity in trails do
		if not alive[entity] then
			trails[entity] = nil
		end
	end
end

function combat.update(c)
	local d = combat.data
	local alpha, zoom, dt = c.alpha, c.camera.zoom, c.dt
	-- Мир начали заново (витрина): прежние клубы и следы — из другого мира.
	if c.tick < lastTick then
		puffs = {}
		trails = {}
	end
	lastTick = c.tick
	local left, top = c:to_world(0, 0)
	local right, bottom = c:to_world(c.screen.w, c.screen.h)
	local function visible(x: number, y: number): boolean
		return x > left - 3 and x < right + 3 and y > top - 3 and y < bottom + 3 and c:sees(x, y)
	end
	-- Размер эффекта в пикселях экрана по его размеру в точках: растёт вместе с миром, но не тоньше пикселя.
	local function sized(points: number): number
		return math.max(points * zoom / d.effectZoom, 1)
	end
	local function line(layer, fromX: number, fromY: number, toX: number, toY: number, thickness: number, color: number, level: number?)
		layer:line(fromX, fromY, toX, toY, color, sized(thickness), level or 1)
	end
	-- Квадрат со стороной в точках вокруг точки.
	local function dot(layer, x: number, y: number, size: number, color: number, level: number?)
		local half = sized(size) / zoom / 2
		layer:line(x - half, y, x + half, y, color, sized(size), level or 1)
	end

	-- Выстрелы и взрывы этого кадра.
	local shots = {}
	for _, e in c:each({ "Shot", "Position" }) do
		local shot = c:get(e, "Shot")
		local weapon = c.protos.weapons[shot.weapon]
		if weapon then
			local at = c:get(e, "Position")
			shot.entity, shot.weapon, shot.x, shot.y = e, weapon.data, at.x, at.y
			shot.rawX, shot.rawY = at.x, at.y
			table.insert(shots, shot)
		end
	end
	local blasts = {}
	for _, e in c:each({ "Blast", "Position" }) do
		local blast = c:get(e, "Blast")
		local at = c:get(e, "Position")
		blast.entity, blast.x, blast.y = e, at.x, at.y
		table.insert(blasts, blast)
	end

	-- Огни: взрывы и вспышки выстрелов светят в темноте.
	for _, blast in blasts do
		local rest = 1 - ageOf(blast, alpha)
		local reach = blast.size * 16
		c:light(blast.x, blast.y - blast.lift, reach * d.blastLight * rest, reach * (d.blastLight / 2) * rest, rest)
	end
	for _, shot in shots do
		if not shot.weapon.speed then
			local rest = 1 - ageOf(shot, alpha)
			c:light(shot.fromX, shot.fromY, 14, 6, rest)
			c:light(shot.toX, shot.toY, 20, 9, rest)
		else
			if shot.age <= d.muzzleTicks then
				c:light(shot.fromX, shot.fromY, 14, 6, 1)
			end
			if shot.weapon.shot == "rocket" then
				c:light(shot.x, shot.y, 10, 4, 0.8)
			end
		end
	end

	emitSmoke(c, shots, blasts)
	-- Дым тормозит, набирает скорость ветра и понемногу всплывает; клубы растут и тают. Ночью он темнее и синее.
	local wind = c.atmosphere.wind or { x = 0, y = 0 }
	local light = c.atmosphere.light or 1
	local day = d.smokeNight + (1 - d.smokeNight) * light
	local warm = day * (0.8 + 0.2 * light)
	local drag = math.exp(-dt * 2.5)
	local puffKind = c.protos.sprites.puff
	local kept = {}
	for _, item in puffs do
		item.age += dt
		if item.age >= item.life then
			continue
		end
		table.insert(kept, item)
		item.speedX = wind.x * d.smokeWind + (item.speedX - wind.x * d.smokeWind) * drag
		item.speedY = wind.y * d.smokeWind - d.smokeRise + (item.speedY - wind.y * d.smokeWind + d.smokeRise) * drag
		item.x += item.speedX * dt
		item.y += item.speedY * dt
		if not visible(item.x, item.y) then
			continue
		end
		local age = item.age / item.life
		local size = item.size * (1 + (item.grow - 1) * age)
		local level = item.level * math.min(1, age * 8) * (1 - age)
		c.draw:sprite(puffKind, item.kind, item.x, item.y, size, rgb(math.min(1, item.shade * warm), math.min(1, item.shade * warm), math.min(1, item.shade * day)), level)
	end
	puffs = kept

	-- Взрывы: кадр по прожитой доле; к концу дым тает.
	local blastKind = c.protos.sprites.blast
	local frames = blastKind.data.frames
	for _, blast in blasts do
		if not visible(blast.x, blast.y) then
			continue
		end
		local age = ageOf(blast, alpha)
		c.draw:sprite(blastKind, math.min(frames - 1, math.floor(age * frames)), blast.x, blast.y - blast.lift, blast.size * d.blastScale, 0xffffff, math.min(1, (1 - age) * 3))
	end

	local point = 1 / d.effectZoom
	local time = c.time
	for _, shot in shots do
		local weapon = shot.weapon
		if not visible(shot.x, shot.y) and not visible(shot.toX, shot.toY) then
			continue
		end
		if not weapon.speed then
			local rest = 1 - ageOf(shot, alpha)
			local dx, dy = shot.toX - shot.fromX, shot.toY - shot.fromY
			if weapon.shot == "flame" then
				-- Струя огня: широкая оранжевая у цели, узкая у ствола, и языки, которые дрожат.
				local seed = shot.entity * 7 + math.floor(time * d.arcRate)
				line(c.glow, shot.fromX, shot.fromY, shot.toX, shot.toY, 5, FLAME, rest * 0.6)
				for i = 1, d.flameTongues do
					local share = i / d.flameTongues
					local sway = (noise(seed, i) - 0.5) * 0.5 * share
					dot(c.glow, shot.fromX + dx * share - dy * sway, shot.fromY + dy * share + dx * sway, 3 + share * 6, if i % 2 == 1 then FLAME else EMBER, rest)
				end
				continue
			end
			if weapon.shot == "laser" then
				line(c.glow, shot.fromX, shot.fromY, shot.toX, shot.toY, 6, LASER, rest * 0.7)
				line(c.glow, shot.fromX, shot.fromY, shot.toX, shot.toY, 2, CORE, rest)
				dot(c.glow, shot.toX, shot.toY, 8, LASER, rest)
				continue
			end
			-- Разряд — ломаная, которая дрожит: изломы меняются много раз в секунду.
			local length = math.sqrt(dx * dx + dy * dy)
			if length == 0 then
				length = 1
			end
			local joints = math.max(2, math.ceil(length / d.arcStep))
			local seed = shot.entity * 13 + math.floor(time * d.arcRate)
			local lastX, lastY = shot.fromX, shot.fromY
			for i = 1, joints do
				local sway = if i == joints then 0 else (noise(seed, i) - 0.5) * 2 * d.arcSway
				local x = shot.fromX + (dx * i) / joints + (-dy / length) * sway
				local y = shot.fromY + (dy * i) / joints + (dx / length) * sway
				line(c.glow, lastX, lastY, x, y, 5, SPARK, rest * 0.8)
				line(c.glow, lastX, lastY, x, y, 1.5, CORE, rest)
				lastX, lastY = x, y
			end
			dot(c.glow, shot.toX, shot.toY, 9, SPARK, rest)
			continue
		end

		local x, y = shot.x, shot.y
		if shot.age <= d.muzzleTicks then
			dot(c.glow, shot.fromX, shot.fromY, if weapon.shot == "bullet" then 5 else 9, BULLET)
		end
		-- Куда летит: по движению за тик, а пока не сдвинулся — к цели.
		local headingX, headingY = shot.rawX - shot.prevX, shot.rawY - shot.prevY
		if headingX == 0 and headingY == 0 then
			headingX, headingY = shot.toX - shot.rawX, shot.toY - shot.rawY
		end
		local speed = math.sqrt(headingX * headingX + headingY * headingY)
		if speed == 0 then
			speed = 1
		end
		headingX /= speed
		headingY /= speed
		if weapon.shot == "bullet" then
			-- След не длиннее пройденного; тёмная подложка: на светлом песке одно свечение не видно.
			local tail = math.min(d.bulletTail, math.sqrt((x - shot.fromX) ^ 2 + (y - shot.fromY) ^ 2))
			line(c.draw, x - headingX * tail, y - headingY * tail, x, y, 2, TRACER)
			line(c.glow, x - headingX * tail, y - headingY * tail, x, y, 2, BULLET)
		elseif weapon.shot == "rocket" then
			-- Ракета идёт по дуге поверх стен: чем выше поднялась, тем дальше её тень на земле.
			local head = y - arcLift(shot, x, y)
			local tailX = x - headingX * d.rocketBody
			local tailY = y - headingY * d.rocketBody - arcLift(shot, tailX, y - headingY * d.rocketBody)
			dot(c.draw, x, y, 4, ROCKET, 0.25)
			line(c.glow, tailX - headingX * 0.2, tailY - headingY * 0.2, tailX, tailY, 3, FLAME)
			line(c.draw, tailX, tailY, x, head, 3, ROCKET)
		else
			-- Ядро летит быстро и прямо, низко над землёй.
			dot(c.draw, x, y, 4, SHELL)
			dot(c.draw, x - point, y - point, 2, ROCKET)
		end
	end

	-- Полоски прочности над повреждёнными юнитами — своими и чужими.
	-- Купола щитов: тусклые в покое, ярче с запасом, вспыхивают от погашенного попадания. Погашенный не рисуется.
	for _, e in c:each({ "Shield", "Building", "Position" }) do
		local shield = c:get(e, "Shield")
		local kind = c:proto(e)
		local spec = kind and kind.data.shield
		if not spec or shield.charge <= 0 then
			continue
		end
		local center = c:get(e, "Position")
		local cx, cy, radius = center.x, center.y, spec.radius
		if not visible(cx - radius, cy) and not visible(cx + radius, cy) and not visible(cx, cy - radius) and not visible(cx, cy + radius) and not visible(cx, cy) then
			continue
		end
		local since = if shield.hit < 0 then math.huge else (c.tick - shield.hit + alpha) * c.step
		local flash = if since < d.domeFlash then 1 - since / d.domeFlash else 0
		local level = 0.12 + 0.18 * (shield.charge / spec.capacity) + 0.6 * flash
		-- Кромка и два кольца ближе к макушке: сверху купол читается как полусфера.
		for _, ring in { { 1, 0, 3, 1 }, { 0.75, 0.18, 2, 0.5 }, { 0.42, 0.32, 2, 0.35 } } do
			local r = radius * ring[1]
			local ringTop = cy - radius * ring[2]
			for i = 0, d.domeSegments - 1 do
				local a = i / d.domeSegments * math.pi * 2
				local b = (i + 1) / d.domeSegments * math.pi * 2
				local shimmer = 0.8 + 0.2 * math.sin(c.time * 2 + i * 0.7 + e)
				line(c.glow, cx + math.cos(a) * r, ringTop + math.sin(a) * r, cx + math.cos(b) * r, ringTop + math.sin(b) * r, ring[3], DOME, level * ring[4] * shimmer)
			end
		end
	end

	local pixel = 1 / zoom
	for _, e in c:each({ "Health", "Mover", "Position" }) do
		local health = c:get(e, "Health").value
		if health >= 1 then
			continue
		end
		local at = c:get(e, "Position")
		if not visible(at.x, at.y) then
			continue
		end
		local mover = c:get(e, "Mover")
		local half = mover.radius + 0.1
		-- Летающий нарисован над землёй там же, где стоит, поэтому полоска на том же месте.
		local barTop = at.y - mover.radius - d.barGap - (if mover.class == "air" then 0.1 else 0)
		c.draw:line(at.x - half - pixel, barTop, at.x + half + pixel, barTop, BAR_BACK, d.barHeight + 2)
		c.draw:line(at.x - half, barTop, at.x - half + half * 2 * math.max(0, health), barTop, if health > 0.5 then BAR_GOOD else BAR_BAD, d.barHeight)
	end
end

return combat
