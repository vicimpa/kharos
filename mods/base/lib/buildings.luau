--!strict
-- Чертежи зданий: ART_TILE пикселей на тайл, как у местности; начало координат — левый верхний угол основания, высокие
-- части уходят в y < 0. Кадров в цикле анимации — FRAMES, чертёж получает фазу цикла t от 0 до 1 и обязан замыкаться
-- при t = 1. Огни кадра — canvas:light.

local goods = require("lib/goods")

local buildings = {}

buildings.TILE = 16
buildings.FRAMES = 16
-- Поля вокруг основания в пикселях спрайта: место для высоких частей.
buildings.PAD = 16

-- Тона от тёмного к светлому. Свет падает слева сверху.
buildings.INK = 0x0b111b
buildings.STEEL = { [0] = 0x1c2b3e, 0x2d4560, 0x41617f, 0x6184a3, 0x9bb9d1 }
buildings.IRON = { [0] = 0x1e2024, 0x3a3d43, 0x5b5f66, 0x8b9097, 0xc3c7cc }
buildings.RUST = { [0] = 0x5e2f24, 0x9a523a, 0xc47a57 }
-- Цвет команды: от погашенного огня к горящему.
buildings.TEAM = { [0] = 0x10358f, 0x1f63d8, 0x5aa9ff, 0xe4f4ff }
buildings.HAZARD = { [0] = 0x1a1608, 0xd9b021 }
buildings.DARK = 0x04070b
-- Материя, которую выдаёт генератор: слитки цвета кредитов.
buildings.GOLD = { [0] = 0xc9962b, 0xf0c95a, 0xfff0b0 }
-- Огонь печи: от тёмно-красного к белому.
buildings.FIRE = { [0] = 0x6a1a10, 0xc2401a, 0xf08a2a, 0xffd36a, 0xfff4d0 }
-- Огнеупорный кирпич печей.
buildings.BRICK = { [0] = 0x2a1a16, 0x5e2f24, 0x9a523a, 0xc47a57, 0xe0a080 }
-- Электрическая дуга: от синего к белому.
buildings.ARC = { [0] = 0x2f5fd0, 0x8fc0ff, 0xf2f8ff }
-- Цвет груза из его вида (goods/): у здания им окрашено то, что оно выдаёт или хранит.
function buildings.goodColor(good: string): number
	return require("goods/" .. good).data.color
end

local INK, TEAM = buildings.INK, buildings.TEAM
local TURN = math.pi * 2
buildings.TURN = TURN

-- Округление как Math.round у JS: половина — вверх (math.round у Luau уводит -0,5 к -1).
function buildings.round(x: number): number
	return math.floor(x + 0.5)
end

-- Огонь печи по яркости от 0 до 1.
function buildings.fireColor(level: number): number
	return buildings.FIRE[math.min(4, math.max(0, math.floor(level * 5)))]
end

-- Воспроизводимое случайное число от 0 до 1 по двум целым.
function buildings.hash(a: number, b: number): number
	local value = math.sin(a * 127.1 + b * 311.7) * 43758.5453
	return value - math.floor(value)
end

-- Три тона цвета: тёмный, основной, светлый — для окраски частей здания цветом его груза (accent).
function buildings.accent(color: number)
	local function mix(amount: number): number
		local function channel(shift: number): number
			local value = bit32.band(bit32.rshift(color, shift), 255)
			local mixed = if amount > 0 then value + (255 - value) * amount else value * (1 + amount)
			return bit32.lshift(buildings.round(mixed), shift)
		end
		return bit32.bor(channel(16), channel(8), channel(0))
	end
	return { [0] = mix(-0.55), mix(-0.15), mix(0.3) }
end

-- Труба с обводкой: горизонтальная, длиной w, осью по строке y.
function buildings.pipe(g, x: number, y: number, w: number)
	g:rect(x, y - 1, w, 3, INK)
	g:rect(x, y, w, 1, buildings.RUST[1])
end

-- Окна цвета команды в ряд: каждое 3×2 с бликом.
function buildings.windows(g, xs: { number }, y: number)
	for _, x in xs do
		g:rect(x, y, 3, 2, TEAM[1])
		g:rect(x, y, 1, 1, TEAM[2])
	end
end

-- Плавное мигание: 1 при t = offset, 0 через полцикла.
function buildings.pulse(t: number, offset: number?): number
	return 0.5 + 0.5 * math.cos(TURN * (t - (offset or 0)))
end

-- Бегущий огонь: вспыхивает при t = offset и быстро гаснет.
function buildings.chase(t: number, offset: number): number
	local phase = ((t - offset) % 1 + 1) % 1
	return math.max(0, 1 - phase * 3)
end

function buildings.teamColor(level: number): number
	return TEAM[math.min(3, math.floor(level * 4))]
end

-- Плита с обводкой, фаской и передней стенкой высотой wall. Размер h — вместе со стенкой.
function buildings.slab(g, x: number, y: number, w: number, h: number, wall: number, tones)
	local top = h - wall - 2
	g:rect(x, y, w, h, INK)
	g:rect(x + 1, y + 1, w - 2, top, tones[1])
	g:rect(x + 1, y + 1, w - 2, 1, tones[3])
	g:rect(x + 1, y + 2, 1, top - 1, tones[2])
	g:rect(x + w - 2, y + 2, 1, top - 1, tones[0])
	g:rect(x + 1, y + 1 + top, w - 2, wall, tones[0])
end

-- Купол: тон светлеет к левому верхнему краю.
function buildings.dome(g, cx: number, cy: number, r: number, tones)
	g:circle(cx, cy, r + 1, INK)
	g:circle(cx, cy, r, tones[0])
	g:circle(cx - r * 0.12, cy - r * 0.12, r * 0.82, tones[1])
	g:circle(cx - r * 0.28, cy - r * 0.28, r * 0.52, tones[2])
	if r >= 4 then
		g:circle(cx - r * 0.42, cy - r * 0.42, r * 0.2, tones[3])
	end
end

-- Круглая башня: основание в (cx, cy), купол поднят на height.
function buildings.tower(g, cx: number, cy: number, r: number, height: number, tones)
	g:circle(cx, cy, r + 1, INK)
	g:rect(cx - r - 1, cy - height, r * 2 + 2, height, INK)
	g:circle(cx, cy, r, tones[0])
	g:rect(cx - r, cy - height, r * 2, height, tones[0])
	g:rect(cx - r + 1, cy - height, math.max(1, math.floor(r / 2)), height + 1, tones[1])
	buildings.dome(g, cx, cy - height, r, tones)
end

-- Круглая лампа цвета команды; светит на землю.
function buildings.lamp(g, cx: number, cy: number, r: number, level: number)
	g:light(cx, cy, r, level)
	g:circle(cx, cy, r + 1, INK)
	g:circle(cx, cy, r, buildings.teamColor(level * 0.74))
	g:circle(cx - r * 0.3, cy - r * 0.3, r * 0.5, buildings.teamColor(0.26 + level * 0.74))
end

-- Огонёк 2×2 с левым верхним углом в (x, y).
function buildings.bulb(g, x: number, y: number, level: number)
	g:rect(x, y, 2, 2, buildings.teamColor(level))
	g:light(x + 1, y + 1, 1, level)
end

-- Сколько тайлов за краем видит здание без своего обзора.
buildings.BUILDING_SIGHT = 4

-- Обзор здания: своё число или половина большей стороны и ещё BUILDING_SIGHT, и не меньше дальности турелей.
function buildings.sight(kind, protos): number
	local data = kind.data
	local range = 0
	for _, mount in data.mounts or {} do
		local turret = protos.turrets[mount.turret]
		local weapon = turret and turret.data.weapon and protos.weapons[turret.data.weapon]
		if weapon then
			range = math.max(range, weapon.data.range)
		end
	end
	local half = math.max(data.width, data.height) / 2
	return math.max(data.sight or half + buildings.BUILDING_SIGHT, if range ~= 0 then range + 1.5 else 0)
end

-- На сколько секунд гаснет пробитый до нуля купол щита.
buildings.SHIELD_DOWN = 10

-- Сущность здания по данным вида: размер, основание (тайлы заняты для хода), обзор, производство.
function buildings.entity(kind, protos)
	local data = kind.data
	local entity = {
		Position = {},
		Owner = {},
		Building = { width = data.width, height = data.height },
		-- Стена и закрытые ворота останавливают выстрелы.
		Footprint = { width = data.width, height = data.height, wall = kind.name == "wall" or kind.name == "gate" },
		-- Чужое здание в тумане игрок помнит таким, каким видел.
		Memorable = { width = data.width, height = data.height },
		Sight = { radius = buildings.sight(kind, protos) },
		-- Прочность без своей — от цены.
		Health = { hp = data.hp or data.cost * buildings.HP_PER_COST },
	}
	entity.Link = buildings.link(kind)
	-- Станция запроса держит заказанное игроком (Wanted).
	if data.requester then
		entity.Wanted = {}
	end
	-- Склад: шахта копит руду, переработка — руду и готовое, хранилище — свой груз.
	entity.Inventory = goods.stock(data)
	-- Производителю без своего склада — склад под материалы заказов.
	if data.produces and not entity.Inventory then
		entity.Inventory = goods.stock({ inventory = buildings.PRODUCER_HOLD })
	end
	-- Цех собирает изделие своего вида; новый стоит выключенным, пока игрок его не включит.
	if data.assembles then
		entity.Assembly = { recipe = data.assembles }
	end
	-- Лаборатория сообщает, как идёт работа (mechanics/research).
	if data.researches then
		entity.Research = {}
	end
	if data.battery then
		entity.Accumulator = {}
	end
	if data.produces then
		entity.Producer = {}
	end
	-- Турели здания стреляют со склада (data.ammo): магазин движка — тот же запас, его ведёт mechanics/supply.
	if data.ammo then
		entity.Magazine = {}
	end
	-- Транспортный луч здания: станция поставки грузит им машины снабжения.
	if data.beam then
		entity.Beam = { radius = data.beam.radius, rate = data.beam.rate, give = data.beam.give == true, take = data.beam.take == true }
	end
	-- Генератор щита держит купол (mechanics/shields): пробитый гаснет на SHIELD_DOWN секунд.
	if data.shield then
		entity.Shield = { radius = data.shield.radius, recover = buildings.SHIELD_DOWN }
	end
	-- Ракетная шахта собирает боеголовку, перехватчик — ракеты-перехватчики (mechanics/silos).
	if data.warhead then
		entity.Silo = {}
	end
	if data.intercept then
		entity.Interceptor = {}
	end
	-- Реактор жжёт стержни (mechanics/reactors).
	if data.burns then
		entity.Reactor = {}
	end
	-- Ворота поднимаются перед чужими (mechanics/gates).
	if data.gate then
		entity.Gate = {}
	end
	-- Турели здания стреляют, пока ему хватает энергии и оно работает (mechanics/economy).
	if data.mounts then
		entity.Throttle = {}
	end
	-- Ремонтная станция чинит своё вокруг (mechanics/construction).
	if data.repair then
		entity.Repair = { radius = data.repair }
	end
	return entity
end

-- На сколько тайлов от своего центра расширяет зону готовое здание без своего радиуса.
buildings.EXPAND_RADIUS = 5
-- Дальше скольких тайлов колодцы не связываются подземным отрезком.
buildings.UNDERGROUND_REACH = 10

-- Связь здания в сеть: круг зоны — свой (data.zone), data.expand или EXPAND_RADIUS; стык — с таким же зданием; труба и
-- колодец — проводники, колодец ещё и подземным отрезком; главное здание — ядро. Стена и ворота (data.isolated) в сеть
-- не входят — nil. Получает готовое здание: стройка и разбор в сеть не входят.
function buildings.link(kind): { [string]: any }?
	local data = kind.data
	if data.isolated then
		return nil
	end
	return {
		radius = data.zone or data.expand or buildings.EXPAND_RADIUS,
		group = kind.name,
		conduit = data.pipe ~= nil,
		tunnel = if data.pipe == "well" then buildings.UNDERGROUND_REACH else 0,
		core = kind.name == "command",
		width = data.width,
		height = data.height,
	}
end

-- Связь площадки (стройки) в сеть: лист — сеть везёт ей материалы, но зону она не расширяет и груз сквозь неё не идёт.
function buildings.siteLink(kind): { [string]: any }
	return { radius = 0, group = kind.name, leaf = true, width = kind.data.width, height = kind.data.height }
end

-- Сколько груза держит производитель без своего склада.
buildings.PRODUCER_HOLD = 100

-- Сколько прочности здания на кредит цены, если своей у него нет.
buildings.HP_PER_COST = 2

-- Биты соседей стены, ворот, трубы и колодца: четыре направления дают 16 вариантов.
buildings.NORTH, buildings.EAST, buildings.SOUTH, buildings.WEST = 1, 2, 4, 8
-- Бит вида ворот поверх битов соседей: плита опущена.
buildings.GATE_OPEN = 16

-- Основание оборонительной турели (emplacement): само вращающееся оружие рисуется поверх отдельной сущностью.
function buildings.emplacement(g, t: number, band: number)
	buildings.slab(g, 0, 1, 16, 15, 2, buildings.STEEL)
	g:circle(8, 8, 6, INK)
	g:circle(8, 8, 5, buildings.IRON[0])
	g:ring(8, 8, 4, 1, band)
	g:circle(8, 8, 2, buildings.IRON[2])
	buildings.bulb(g, 1, 2, buildings.pulse(t))
	buildings.bulb(g, 13, 2, buildings.pulse(t, 0.5))
end

export type LookOptions = {
	-- Есть ли у здания вид работы: тогда кадров вдвое больше — вторая половина рисуется с working.
	working: boolean?,
	-- Вариантов соседства (стены, ворота, трубы): они — направления облика.
	variants: number?,
}

-- Облик здания width × height тайлов: draw(canvas, t, working, variant) — чертёж.
function buildings.look(width: number, height: number, draw: (any, number, boolean, number) -> (), options: LookOptions?)
	local pad, tile, frames = buildings.PAD, buildings.TILE, buildings.FRAMES
	local o: LookOptions = options or {}
	local variants = o.variants or 1
	return {
		size = { width * tile + pad * 2, height * tile + pad * 2 },
		origin = { pad, pad },
		-- Место сущности — центр основания.
		anchor = { width * tile / 2, height * tile / 2 },
		directions = variants,
		phases = if o.working then frames * 2 else frames,
		fps = 8,
		layer = "building",
		shadow = { 3, 0.4 },
		-- Вторая половина кадров — работа: её показывают, когда подача скажет (c:dress, effects/power).
		working = o.working,
		draw = function(canvas, angle: number, phase: number)
			local variant = math.floor(angle / TURN * variants + 0.5) % variants
			draw(canvas, (phase % frames) / frames, phase >= frames, variant)
		end,
		-- Портрет: первый кадр работы с полем в 2 пикселя.
		portrait = {
			size = { width * tile + 4, height * tile + 4 },
			origin = { 2, 2 },
			draw = function(canvas)
				draw(canvas, 0, true, 0)
			end,
		},
	}
end

return buildings
