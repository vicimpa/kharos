--!strict
-- Месторождения: как их кладёт генератор и как они выглядят. В каждой клетке CELL × CELL тайлов не больше одного
-- месторождения SIZE × SIZE на скале, где можно строить; вид — по биому, запас — по виду.

local deposits = {}

-- Сторона клетки и месторождения в тайлах.
deposits.CELL = 40
deposits.SIZE = 2
-- В какой доле клеток месторождение есть, если генератор не задал своей; сколько мест пробуется; сдвиг сида.
local CHANCE = 0.95
local ATTEMPTS = 6
local SALT = 17011
-- Виды по порядку DEPOSIT_TYPES: от него зависит, какой вид выпадет по биому.
deposits.TYPES = { "metal", "silicon", "fuel", "kharite", "lithium", "uranium" }

-- Тона породы каждого вида от тёмного к блику.
local TONES = {
	metal = { [0] = 0x6b2f1e, 0xb5562e, 0xe58a4a, 0xffd9a0 },
	silicon = { [0] = 0x6e6856, 0xa9a184, 0xe0d9bc, 0xffffff },
	fuel = { [0] = 0x0d0b10, 0x221d29, 0x3a3340, 0x8f86a8 },
	kharite = { [0] = 0x2e1247, 0x6a2fa8, 0xc06bff, 0xf3dcff },
	lithium = { [0] = 0x5a2a3e, 0xb0607e, 0xf0a0c0, 0xffe6f0 },
	uranium = { [0] = 0x1f2a0a, 0x4a6a1a, 0x9bd040, 0xe8ffb0 },
}
local INK = 0x2a1410
-- Глыбы породы: левый верхний угол, ширина и высота; рудная крошка между ними.
local CHUNKS = { { 3, 5, 7, 5 }, { 13, 2, 6, 4 }, { 22, 6, 7, 6 }, { 9, 11, 9, 7 }, { 1, 15, 6, 5 }, { 21, 16, 8, 6 }, { 5, 23, 7, 5 }, { 15, 22, 6, 6 }, { 25, 25, 5, 4 } }
local CRUMBS = { { 11, 8 }, { 20, 3 }, { 29, 14 }, { 2, 11 }, { 18, 19 }, { 8, 20 }, { 13, 29 }, { 23, 23 }, { 30, 21 }, { 1, 27 }, { 19, 13 }, { 27, 2 } }

-- Топливо: тёмная лужа с радужным бликом и брызгами вокруг.
local function drawOil(g)
	local tones = TONES.fuel
	for _, crumb in CRUMBS do
		g:rect(crumb[1], crumb[2], 2, 1, tones[1])
	end
	g:circle(15, 16, 11, INK)
	g:circle(15, 16, 10, tones[0])
	g:circle(20, 21, 6, tones[0])
	g:circle(13, 14, 7, tones[1])
	g:rect(9, 11, 6, 1, tones[2])
	g:rect(10, 12, 3, 1, tones[3])
	g:rect(19, 19, 3, 1, 0x4a6a8a)
end

-- Месторождение: угловатые глыбы породы с жилами и крошка вокруг; топливо — лужей.
local function drawDeposit(g, kind: string)
	if kind == "fuel" then
		return drawOil(g)
	end
	local ore = TONES[kind]
	for _, crumb in CRUMBS do
		g:rect(crumb[1], crumb[2], 2, 1, ore[1])
	end
	for i, chunk in CHUNKS do
		local x, y, w, h = chunk[1], chunk[2], chunk[3], chunk[4]
		-- Срезанные углы делают глыбу гранёной.
		g:rect(x + 1, y, w - 2, h, INK)
		g:rect(x, y + 1, w, h - 2, INK)
		g:rect(x + 1, y + 1, w - 2, h - 2, ore[0])
		g:rect(x + 1, y + 1, w - 3, h - 3, ore[1])
		-- Жила: светлая грань сверху слева и блик на каждой второй глыбе.
		g:rect(x + 1, y + 1, math.ceil(w / 2), 1, ore[2])
		g:rect(x + 1, y + 2, 1, math.max(1, h - 4), ore[2])
		if (i - 1) % 2 == 0 then
			g:rect(x + 2, y + 2, 1, 1, ore[3])
		end
	end
end

-- Облик месторождения вида kind: на земле, без тени, виден там, где разведано.
function deposits.look(kind: string)
	local side = deposits.SIZE * 16
	return {
		size = side,
		origin = { 0, 0 },
		anchor = { side / 2, side / 2 },
		layer = "floor",
		shadow = false,
		memory = true,
		draw = function(canvas)
			drawDeposit(canvas, kind)
		end,
		portrait = { size = side, origin = { 0, 0 }, draw = function(canvas)
			drawDeposit(canvas, kind)
		end },
	}
end

-- Вид месторождения по биому (0..3) и случайному числу 0..1: доли видов — data.biomes видов раздела deposits.
local BIOMES = { [0] = "erg", "saltFlats", "redWastes", "marsh" }

local function kindIn(kinds, biome: number, pick: number): string
	local name = BIOMES[biome] or "erg"
	for _, kind in deposits.TYPES do
		local spec = kinds[kind]
		if spec then
			pick -= spec.data.biomes[name]
			if pick < 0 then
				return kind
			end
		end
	end
	return "metal"
end

-- Генератор местности партии и карта: вид местности, поверх data.generator и сид партии (land_config хоста); nil —
-- у партии нет карты.
function deposits.setup(ctx)
	local data = ctx.game.data or {}
	local size = data.size
	local land = data.land and ctx.protos.lands[data.land]
	if not size or not land then
		return nil
	end
	local config = table.clone(land.data)
	for key, value in data.generator or {} do
		config[key] = value
	end
	config.seed = data.seed or config.seed
	return { config = config, bounds = { left = -size, top = -size, right = size, bottom = size } }
end

-- Месторождение клетки по генератору: левый верхний тайл, вид, запас; nil — нет. ctx даёт местность (terrain) и hash,
-- bounds — карта, kinds — виды раздела deposits, config — генератор.
function deposits.generate(ctx, kinds, config, bounds, cellX: number, cellY: number)
	local seed = config.seed + SALT
	if ctx.hash(cellX, cellY, seed) >= (config.depositChance or CHANCE) then
		return nil
	end
	return deposits.placeIn(ctx, kinds, config, bounds, cellX, cellY, function(k: number): number
		return ctx.hash(cellX, cellY, seed + k)
	end)
end

-- Месторождение в клетке по случайным числам random(k): место — первое из ATTEMPTS, где можно строить и где fits не
-- против; вид — по биому; запас — по виду. Нет такого места — nil.
function deposits.placeIn(ctx, kinds, config, bounds, cellX: number, cellY: number, random: (number) -> number, fits: ((number, number) -> boolean)?)
	local room = deposits.CELL - deposits.SIZE
	for attempt = 0, ATTEMPTS - 1 do
		local x = cellX * deposits.CELL + math.floor(random(1 + attempt * 2) * room)
		local y = cellY * deposits.CELL + math.floor(random(2 + attempt * 2) * room)
		if x < bounds.left or y < bounds.top or x + deposits.SIZE > bounds.right or y + deposits.SIZE > bounds.bottom then
			continue
		end
		local buildable = true
		for tileY = y, y + deposits.SIZE - 1 do
			for tileX = x, x + deposits.SIZE - 1 do
				local terrain, _, foot = ctx:terrain(tileX, tileY)
				-- Шахта встаёт на месторождение: тайлы те же, что годятся под здание, — скала не у подножия обрыва.
				if terrain ~= 2 or foot then
					buildable = false
				end
			end
		end
		if buildable and (not fits or fits(x, y)) then
			local _, biome = ctx:terrain(x, y)
			local kind = kindIn(kinds, biome, random(53))
			local spec = kinds[kind].data
			local reserve = math.round((spec.min + random(97) * (spec.max - spec.min)) * (config.depositRichness or 1))
			return { x = x, y = y, kind = kind, reserve = reserve }
		end
	end
	return nil
end

return deposits
