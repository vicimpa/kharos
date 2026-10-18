--!strict
-- Юниты и турели: облик по чертежу вида и сущность по его данным. Чертёж юнита или турели лежит в файле вида и рисует
-- пером (units.pen) вид сверху в пикселях спрайта, 16 на тайл, начало координат — центр юнита; каждое направление —
-- заново: повёрнутый чертёж растеризуется чище, чем повёрнутая картинка. Здесь — палитра и общие детали чертежей:
-- колёса, гусеницы, ноги, корпус тяжёлой машины, пушка главного здания. Массивы цветов — с нуля.

local goods = require("lib/goods")
local kinds = require("lib/kinds")

local units = {}

-- Какую долю прочности в секунду пехотинец восстанавливает сам.
units.INFANTRY_REGEN = 0.02

-- Сторона кадра в пикселях: два тайла.
units.FRAME = 32
-- Кадров поворота: соседние отличаются меньше чем на пиксель-два, поворот выглядит непрерывным.
units.DIRECTIONS = 64
-- Кадров хода наземного юнита; протектор и звенья повторяются через столько пикселей и сдвигаются на пиксель за кадр.
units.PHASES = 4
-- Тайлов пути на кадр хода: колёса и гусеницы — пиксель за пиксель пути, ноги шагают реже.
units.STEP = { tracks = 1 / 16, wheels = 1 / 16, legs = 0.2 }

-- Цвета сторон: тёмный, основной, светлый. Свои — синие, чужие — красные, союзники — зелёные.
units.TEAMS = {
	own = { 0x1f63d8, 0x5aa9ff, 0xe4f4ff },
	foe = { 0xb3261e, 0xff6b5a, 0xffe9e4 },
	ally = { 0x1f7a3c, 0x4ec973, 0xe8fff0 },
}

local function toned(color: number, tone: number): number
	return color + (tone + 1) * 0x1000000
end

-- Маска цвета стороны: спрайт рисуется один раз на все стороны, цвет подставляет шейдер палитрой.
local MASK_TEAM = { [0] = toned(0x1f63d8, 0), toned(0x5aa9ff, 1), toned(0xe4f4ff, 2) }

-- Палитра чертежей: обводка, сталь, железо, жёлтая окраска, голубое свечение — от тёмного к светлому.
units.INK = 0x0b111b
units.STEEL = { [0] = 0x1c2b3e, 0x2d4560, 0x41617f, 0x6184a3, 0x9bb9d1 }
units.IRON = { [0] = 0x1e2024, 0x3a3d43, 0x5b5f66, 0x8b9097, 0xc3c7cc }
units.HAZARD = { [0] = 0x7a5a16, 0xc9962b, 0xf0c95a }
units.ENERGY = { [0] = 0x4f9dff, 0x9fd0ff, 0xf2fbff }
local INK, STEEL, IRON, ENERGY = units.INK, units.STEEL, units.IRON, units.ENERGY
local PHASES = units.PHASES

-- Перо, повёрнутое вместе с юнитом: координаты — вперёд (along) и вправо (across) от его центра. Так чертёж описывается
-- один раз, как будто юнит смотрит вправо.
function units.pen(g, angle: number)
	local forwardX, forwardY = math.cos(angle), math.sin(angle)
	local function x(along: number, across: number): number
		return along * forwardX - across * forwardY
	end
	local function y(along: number, across: number): number
		return along * forwardY + across * forwardX
	end
	return {
		-- Брусок вдоль хода: от from до to по оси «вперёд», со сдвигом across вбок, толщиной width.
		bar = function(from: number, to: number, across: number, width: number, color: number)
			g:line(x(from, across), y(from, across), x(to, across), y(to, across), width, color)
		end,
		-- Брусок поперёк хода: на расстоянии along вперёд, от from до to по оси «вправо».
		beam = function(along: number, from: number, to: number, width: number, color: number)
			g:line(x(along, from), y(along, from), x(along, to), y(along, to), width, color)
		end,
		dot = function(along: number, across: number, radius: number, color: number)
			g:circle(x(along, across), y(along, across), radius, color)
		end,
		-- Отрезок между двумя точками, каждая — вперёд и вправо от центра.
		line = function(fromAlong: number, fromAcross: number, toAlong: number, toAcross: number, width: number, color: number)
			g:line(x(fromAlong, fromAcross), y(fromAlong, fromAcross), x(toAlong, toAcross), y(toAlong, toAcross), width, color)
		end,
	}
end

-- Поперечные полоски через PHASES пикселей на отрезке от from до to вдоль хода: звенья гусеницы или протектор шины.
-- На кадре phase они сдвинуты вперёд на phase пикселей.
function units.treads(p, from: number, to: number, across: number, half: number, phase: number, color: number)
	local along = from + phase
	while along - PHASES >= from do
		along -= PHASES
	end
	while along <= to do
		p.beam(along, across - half, across + half, 1, color)
		along += PHASES
	end
end

-- Шина: чёрный брусок длиной 2·half вдоль хода, по которому бежит протектор.
function units.tire(p, along: number, across: number, half: number, width: number, phase: number)
	p.bar(along - half, along + half, across, width, INK)
	units.treads(p, along - half + 0.5, along + half - 0.5, across, width / 2 - 0.5, phase, IRON[2])
end

-- Ноги пехотинца: на кадрах 1 и 3 одна ступня впереди, другая сзади; на 0 и 2 обе под плечами.
function units.legs(p, phase: number)
	local stride = if phase == 1 then 2.6 elseif phase == 3 then -2.6 else 0
	if stride == 0 then
		return
	end
	for _, across in { -1.5, 1.5 } do
		local along = if across < 0 then stride else -stride
		p.dot(along, across, 1.3, INK)
		p.dot(along, across, 0.7, IRON[2])
	end
end

-- Колёса лёгкой машины: по два с каждого борта.
function units.wheels(p, side: number, spread: number, phase: number)
	for _, across in { -side, side } do
		for _, wheel in { -spread, spread } do
			units.tire(p, wheel, across, 2, 3, phase)
		end
	end
end

-- Гусеницы и корпус тяжёлой машины.
function units.heavyHull(p, team, phase: number)
	for _, side in { -7.5, 7.5 } do
		p.bar(-11, 11, side, 6, INK)
		p.bar(-10, 10, side, 4, IRON[1])
		units.treads(p, -10, 10, side, 2, phase, IRON[0])
	end
	p.bar(-9, 10, 0, 12, INK)
	p.bar(-8, 9, 0, 10, STEEL[1])
	p.bar(-8, 9, -4, 2, STEEL[2])
	p.bar(-8, -6, 0, 10, team[0])
end

-- Пушка главного здания: широкий купол цвета команды с линзой и спаренный излучатель с голубыми концами. Купол —
-- along пикселей вперёд от центра, стволы длиной reach. Та же пушка стоит на крыше главного здания и на MCV.
function units.coreGun(p, along: number, reach: number, team)
	for _, side in { -2.2, 2.2 } do
		p.bar(along + 2, along + reach, side, 2.8, INK)
		p.bar(along + 2.5, along + reach - 0.5, side, 1.4, IRON[3])
		p.dot(along + reach, side, 1.3, ENERGY[1])
		p.dot(along + reach, side, 0.6, ENERGY[2])
	end
	p.dot(along, 0, 7.2, INK)
	p.dot(along, 0, 6.2, STEEL[2])
	p.dot(along - 0.8, 0, 4.8, team[0])
	p.dot(along - 1.8, -1.8, 2, team[1])
	p.dot(along + 2.2, 0, 1.8, INK)
	p.dot(along + 2.2, 0, 1.1, ENERGY[0])
end

-- Угол портрета: юнит смотрит вправо вверх.
local PORTRAIT_ANGLE = -math.pi / 4

-- Цвета стороны ({ тёмный, основной, светлый }) — палитрой чертежа, с нуля: так рисуются остовы (sprites/wreck).
local function palette(team: { number })
	return { [0] = team[1], team[2], team[3] }
end

export type Art = (p: any, team: { [number]: number }, phase: number) -> ()

export type UnitLook = {
	-- Чем юнит ходит — от этого анимация хода и слой: "tracks", "wheels", "legs", "air".
	gait: string,
	-- Чертёж: перо units.pen, повёрнутое вместе с юнитом, цвета стороны (team[0..2]) и кадр хода.
	draw: Art,
	-- Турели на корпусе (data.mounts): на портрете они рисуются на своих местах.
	mounts: { any }?,
	-- Следы на земле (effects/traces): где лежат, в пикселях спрайта вправо от оси юнита, и какой ширины.
	traces: { sides: { number }, width: number }?,
	-- Свет: фары (вдоль, поперёк — в пикселях спрайта, радиус ореола) и луч вперёд из точки along на оси юнита.
	lights: { [string]: any }?,
}

-- Облик юнита: кадр, направления, фазы хода, огни — для поля look вида. paint(canvas, угол, цвета стороны, кадр) —
-- тот же чертёж не в маске, а в цветах стороны.
function units.look(spec: UnitLook)
	local gait = spec.gait
	local air = gait == "air"
	local art = spec.draw
	return {
		portrait = {
			size = units.FRAME,
			draw = function(canvas)
				art(units.pen(canvas, PORTRAIT_ANGLE), MASK_TEAM, 0)
				for _, mount in spec.mounts or {} do
					local c, s = math.cos(PORTRAIT_ANGLE), math.sin(PORTRAIT_ANGLE)
					local x = (c * mount.along - s * mount.across) * 16
					local y = (s * mount.along + c * mount.across) * 16
					canvas:translate(x, y)
					require("turrets/" .. mount.turret).look.draw(canvas, PORTRAIT_ANGLE, 0)
					canvas:translate(-x, -y)
				end
			end,
		},
		size = units.FRAME,
		directions = units.DIRECTIONS,
		phases = if air then 1 else units.PHASES,
		step = units.STEP[gait],
		layer = if air then "air" else "ground",
		shadow = if air then { 10, 0.25 } else { 2, 0.4 },
		draw = function(canvas, angle: number, phase: number)
			art(units.pen(canvas, angle), MASK_TEAM, phase)
		end,
		paint = function(canvas, angle: number, team: { number }, phase: number)
			art(units.pen(canvas, angle), palette(team), phase)
		end,
		lights = spec.lights,
		-- Ноги шагают, а не катятся.
		traces = if spec.traces then { sides = spec.traces.sides, width = spec.traces.width, legs = gait == "legs" } else nil,
		-- Значок в панелях — направление 56 из 64: юнит смотрит вправо вверх.
		icon = { direction = 56 },
	}
end

-- Сколько тайлов видит юнит каждого рода, если у вида нет своего числа, и насколько обзор дальше оружия.
local CLASS_SIGHT = { infantry = 7, air = 10 }
local SIGHT_OVER_RANGE = 1.5

-- Дальность самого дальнобойного оружия — своего или на турелях.
function units.range(data, protos): number
	local range = 0
	local function arm(weapon: string?)
		local spec = weapon and protos.weapons[weapon]
		if spec then
			range = math.max(range, spec.data.range)
		end
	end
	arm(data.weapon)
	for _, mount in data.mounts or {} do
		local turret = protos.turrets[mount.turret]
		arm(turret and turret.data.weapon)
	end
	return range
end

-- Сколько тайлов от центра видит юнит вида: своё число или по роду, и не меньше дальности оружия.
function units.sight(kind, protos): number
	local data = kind.data
	local range = units.range(data, protos)
	return math.max(data.sight or CLASS_SIGHT[data.kind] or 8, if range ~= 0 then range + SIGHT_OVER_RANGE else 0)
end

-- Сущность юнита по данным вида: ход (Mover) — скорость, поворот, радиус, род; обзор, прочность, своё оружие, склад; что
-- нужно механикам (магазин, луч, ремонт…), добавляют они сами (kinds.equip).
function units.entity(kind, protos)
	local data = kind.data
	local infantry = data.kind == "infantry"
	local entity = {
		Position = {},
		Facing = {},
		Owner = {},
		Unit = {},
		Mover = { speed = data.speed, turn = data.turn, radius = data.radius, class = data.kind },
		Sight = { radius = units.sight(kind, protos) },
		-- Пехоту не чинят, зато она понемногу поправляется сама.
		Health = { hp = data.hp, repairable = not infantry, regen = if infantry then units.INFANTRY_REGEN else 0 },
		Inventory = goods.stock(data),
	}
	-- Своё оружие — у корпуса: выстрел вылетает с края юнита.
	if data.weapon then
		entity.Armed = { weapon = data.weapon, turn = data.turn, radius = data.radius }
	end
	return kinds.equip(kind, entity, protos)
end

-- Сущность турели: место и поворот на носителе — Attached (ставит mechanics/mounts).
function units.turretEntity(kind, protos)
	local data = kind.data
	local entity = { Position = {}, Facing = {}, Owner = {}, Turret = {}, Attached = {} }
	if data.weapon then
		entity.Armed = { weapon = data.weapon, turn = data.turn, radius = data.radius }
	end
	return kinds.equip(kind, entity, protos)
end

-- Облик турели по чертежу (перо и цвета стороны): свой кадр в 32 пикселя, одно положение хода, тень — вдвое ближе,
-- чем у носителя. paint — как у юнита.
function units.turretLook(art: Art)
	return {
		size = 32,
		directions = units.DIRECTIONS,
		shadow = { 1, 0.4 },
		draw = function(canvas, angle: number)
			art(units.pen(canvas, angle), MASK_TEAM, 0)
		end,
		paint = function(canvas, angle: number, team: { number })
			art(units.pen(canvas, angle), palette(team), 0)
		end,
	}
end

return units
