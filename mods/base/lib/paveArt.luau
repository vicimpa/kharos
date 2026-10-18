--!strict
-- Рисунок покрытия: тайл 16×16 фундамента, дороги и моста на каждый набор соседей — битами сверху 1, справа 2, снизу 4,
-- слева 8; край рисуется там, где соседа того же вида нет. Из тех же тайлов — значки тем и кнопок (icons/foundation,
-- roads, bridges, remove).

local paveArt = {}

paveArt.TILE = 16
paveArt.UP, paveArt.RIGHT, paveArt.DOWN, paveArt.LEFT = 1, 2, 4, 8
-- Облики по порядку фаз sprites/paving: на каждый — 16 наборов соседей.
paveArt.LOOKS = { "foundation", "road", "bridge" }

local TILE = paveArt.TILE
local UP, RIGHT, DOWN, LEFT = paveArt.UP, paveArt.RIGHT, paveArt.DOWN, paveArt.LEFT

-- Простое воспроизводимое случайное число от 0 до 1 по двум целым (noise).
local function noise(a: number, b: number): number
	local value = math.sin(a * 127.1 + b * 311.7) * 43758.5453
	return value - math.floor(value)
end

local function has(mask: number, bit: number): boolean
	return bit32.band(mask, bit) ~= 0
end

-- Фундамент: бетонная плита со швами по краю и болтами по углам. Соседние плиты сливаются в площадку.
local function foundation(g, mask: number)
	g:rect(0, 0, TILE, TILE, 0x8d8a82)
	for i = 0, 17 do
		g:rect(math.floor(noise(i, 1) * 16), math.floor(noise(i, 2) * 16), 1, 1, if noise(i, 3) < 0.5 then 0x7d7a73 else 0x9c998f)
	end
	-- Шов между плитами — тонкий, край площадки — тёмный бордюр.
	local function edge(open: boolean): number
		return if open then 0x4f4c47 else 0x77746d
	end
	g:rect(0, 0, TILE, 1, edge(not has(mask, UP)))
	g:rect(0, TILE - 1, TILE, 1, edge(not has(mask, DOWN)))
	g:rect(0, 0, 1, TILE, edge(not has(mask, LEFT)))
	g:rect(TILE - 1, 0, 1, TILE, edge(not has(mask, RIGHT)))
	for _, bolt in { { 3, 3 }, { 12, 3 }, { 3, 12 }, { 12, 12 } } do
		g:rect(bolt[1], bolt[2], 1, 1, 0x5d5a54)
	end
end

-- Дорога: укатанное покрытие с зернистостью, по открытым сторонам — бордюр.
local function road(g, mask: number)
	g:rect(0, 0, TILE, TILE, 0x45403b)
	for i = 0, 23 do
		g:rect(math.floor(noise(i, 7) * 16), math.floor(noise(i, 8) * 16), 1, 1, if noise(i, 9) < 0.5 then 0x3a3632 else 0x524c46)
	end
	local curb = 0x8c8273
	if not has(mask, UP) then
		g:rect(0, 0, TILE, 2, curb)
	end
	if not has(mask, DOWN) then
		g:rect(0, TILE - 2, TILE, 2, curb)
	end
	if not has(mask, LEFT) then
		g:rect(0, 0, 2, TILE, curb)
	end
	if not has(mask, RIGHT) then
		g:rect(TILE - 2, 0, 2, TILE, curb)
	end
end

-- Мост: настил из досок поперёк хода на сваях, по открытым сторонам — перила.
local function bridge(g, mask: number)
	local across = not has(mask, bit32.bor(LEFT, RIGHT)) and has(mask, bit32.bor(UP, DOWN))
	for i = 0, TILE - 1, 4 do
		local tone = if i % 8 ~= 0 then 0x6e4b2c else 0x7d5733
		if across then
			g:rect(0, i, TILE, 3, tone)
		else
			g:rect(i, 0, 3, TILE, tone)
		end
	end
	-- Щели между досками.
	for i = 3, TILE - 1, 4 do
		if across then
			g:rect(0, i, TILE, 1, 0x3b2a1a)
		else
			g:rect(i, 0, 1, TILE, 0x3b2a1a)
		end
	end
	local rail, post = 0x2f2a26, 0x8f8a80
	if not has(mask, UP) then
		g:rect(0, 0, TILE, 2, rail)
		g:rect(1, 0, 2, 2, post)
		g:rect(TILE - 3, 0, 2, 2, post)
	end
	if not has(mask, DOWN) then
		g:rect(0, TILE - 2, TILE, 2, rail)
		g:rect(1, TILE - 2, 2, 2, post)
		g:rect(TILE - 3, TILE - 2, 2, 2, post)
	end
	if not has(mask, LEFT) then
		g:rect(0, 0, 2, TILE, rail)
		g:rect(0, 1, 2, 2, post)
		g:rect(0, TILE - 3, 2, 2, post)
	end
	if not has(mask, RIGHT) then
		g:rect(TILE - 2, 0, 2, TILE, rail)
		g:rect(TILE - 2, 1, 2, 2, post)
		g:rect(TILE - 2, TILE - 3, 2, 2, post)
	end
end

local DRAW = { foundation = foundation, road = road, bridge = bridge }

-- Тайл облика look с соседями mask — в левый верхний угол холста.
function paveArt.draw(g, look: string, mask: number)
	DRAW[look](g, mask)
end

-- Тайлы значков 32×32: площадка 2×2 фундамента, полоса дороги или моста посередине.
local ICONS = {
	foundation = { { { "foundation", 6 }, { "foundation", 12 } }, { { "foundation", 3 }, { "foundation", 9 } } },
	remove = { { { "foundation", 6 }, { "foundation", 12 } }, { { "foundation", 3 }, { "foundation", 9 } } },
	road = { { { "road", 2 }, { "road", 8 } } },
	bridge = { { { "bridge", 2 }, { "bridge", 8 } } },
	peak = {},
	cliff = {},
}

local OUTLINE = 0x1a1410

-- Гора с киркой: треугольник скалы со снежной шапкой и кирка поперёк.
local function peakIcon(g)
	for row = 0, 19 do
		local half = math.floor(row * 0.7 + 0.5) + 1
		local y = 6 + row
		g:rect(16 - half - 1, y, half * 2 + 2, 1, OUTLINE)
		g:rect(16 - half, y, half, 1, 0x9a8a74)
		g:rect(16, y, half, 1, 0x6e604f)
		if row < 5 then
			g:rect(16 - half, y, half * 2, 1, 0xdcd4c6)
		end
	end
	g:rect(2, 26, 28, 2, OUTLINE)
	g:line(9, 27, 23, 11, 4, OUTLINE)
	g:line(9, 27, 23, 11, 2, 0x8a5426)
	g:line(17, 7, 28, 15, 5, OUTLINE)
	g:line(17, 7, 28, 15, 3, 0xc8ccd0)
end

-- Обрыв со спуском: уступ плато слева, земля справа, между ними — пологий пандус.
local function cliffIcon(g)
	g:rect(2, 9, 15, 19, OUTLINE)
	g:rect(3, 10, 13, 17, 0x9a8a74)
	g:rect(3, 10, 13, 3, 0xb4a48c)
	g:rect(2, 22, 28, 6, OUTLINE)
	g:rect(3, 23, 26, 4, 0x7e705e)
	for step = 0, 11 do
		g:rect(16 + step, 11 + step, 2, 12 - step, if step % 2 == 1 then 0xc0ae92 else 0xb4a48c)
	end
	g:line(16, 10, 29, 23, 2, OUTLINE)
	g:line(18, 9, 25, 16, 2, 0xe0902c)
	g:line(25, 16, 25, 11, 2, 0xe0902c)
	g:line(25, 16, 20, 16, 2, 0xe0902c)
end

-- Значок 32×32: foundation, road, bridge, remove — плиты с красным крестом, peak — гора с киркой, cliff — обрыв со
-- спуском.
function paveArt.icon(g, icon: string)
	local rows = ICONS[icon]
	local top = (32 - #rows * TILE) / 2
	for y, row in rows do
		for x, tile in row do
			local dx, dy = (x - 1) * TILE, top + (y - 1) * TILE
			g:translate(dx, dy)
			DRAW[tile[1]](g, tile[2])
			g:translate(-dx, -dy)
		end
	end
	if icon == "peak" then
		peakIcon(g)
	elseif icon == "cliff" then
		cliffIcon(g)
	end
	if icon == "remove" then
		g:line(7, 7, 25, 25, 4, 0x1a0806)
		g:line(25, 7, 7, 25, 4, 0x1a0806)
		g:line(7, 7, 25, 25, 2, 0xe0402c)
		g:line(25, 7, 7, 25, 2, 0xe0402c)
	end
end

return paveArt
