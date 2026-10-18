--!strict
-- Покрытие тайлов, общий хосту (ctx) и клиенту (c). Фундамент: на нём здания строятся быстрее, на песке он вообще
-- разрешает стройку, а зону строительства не заменяет; ходят по нему чуть быстрее, чем по скале. Дорога: наземные по
-- ней едут быстрее, а положенная на болото — это мост, по которому болото не вязнет и не жжёт. Покрытие — не здание: по
-- нему не стреляют, оно не видит и не мешает ходить.
--
-- Готовое покрытие — слой карты layers/paving (канал 0 — вид: 1 фундамент, 2 дорога; канал 1 — хозяин): его на большой
-- базе десятки тысяч тайлов, и сущностями оно отягощало бы каждый обход мира. Скорость по нему считает ход движка
-- (data.rules.surface, surfaceSpeeds). Работа над покрытием — укладка и разбор — сущность с Pave посреди тайла; её
-- номер лежит в слое layers/paveWork. Её строят и разбирают строители, как площадку (mechanics/construction);
-- достроенное уходит в слой, разбираемое лежит в слое и действует, пока его не разберут до конца.

local construction = require("lib/construction")
local zones = require("lib/zones")
local kinds = require("lib/kinds")
local surface = require("lib/surface")

local paving = {}

-- Виды покрытия по коду в слое.
paving.KINDS = { "foundation", "road" }
paving.CODE = { foundation = 1, road = 2 }

-- Цена тайла фундамента, дороги и моста — дороги по болоту.
paving.FOUNDATION_COST = 15
paving.ROAD_COST = 5
paving.BRIDGE_COST = 20
-- Во сколько раз быстрее строится здание на фундаменте на скале; на песке — доля скорости на голой скале.
paving.FOUNDATION_ROCK = 2
paving.FOUNDATION_SAND = 0.8
-- Сколько тайлов можно заложить одной командой.
paving.LIMIT = 400
-- Темы, которые открывают покрытие: фундамент, дороги и дорогу по болоту — мосты.
paving.RESEARCH = { foundation = "foundation", road = "roads", bridge = "bridges", peak = "earthworks", cliff = "earthworks" }

-- Что открывают темы покрытия — названия (grid.tools) и значки по порядку PAVE_RESEARCH.
paving.OPENS = { "foundation", "road", "bridge", "peak", "cliff" }
paving.TITLES = { foundation = "grid.tools.foundation", road = "grid.tools.road", bridge = "grid.tools.bridge", remove = "grid.remove", peak = "grid.tools.peak", cliff = "grid.tools.cliff" }
paving.ICONS = { foundation = "foundation", road = "roads", bridge = "bridges", remove = "remove", peak = "peak", cliff = "cliff" }

-- Что из покрытия открывает тема: foundation, road, bridge.
function paving.opens(topic: string): { string }
	local list = {}
	for _, kind in paving.OPENS do
		if paving.RESEARCH[kind] == topic then
			table.insert(list, kind)
		end
	end
	return list
end

-- Виды местности (w:terrain).
local SWAMP, SAND, ROCK, MOUNTAIN = 0, 1, 2, 3

local enabled, laid, at, ownerAt = surface.enabled, surface.laid, surface.at, surface.ownerAt
paving.enabled, paving.laid, paving.at, paving.ownerAt = enabled, laid, at, ownerAt
paving.isPaved, paving.isRoadway, paving.tileOf, paving.drawnAt = surface.isPaved, surface.isRoadway, surface.tileOf, surface.drawnAt

-- Что стоит тайл покрытия: дорога по болоту — мост — дороже.
function paving.cost(w, kind: string, x: number, y: number): number
	if kind == "foundation" then
		return paving.FOUNDATION_COST
	end
	return if w:terrain(x, y) == SWAMP then paving.BRIDGE_COST else paving.ROAD_COST
end

-- Своё ли это: сущность игрока.
local function isOwn(w, player: number, e: number): boolean
	local owner = w:get(e, "Owner")
	return owner ~= nil and owner.player == player
end

-- Здание или площадка на тайле.
local function standingAt(w, x: number, y: number): number?
	return w:occupant(x, y) or construction.siteAt(w, x, y)
end

-- Можно ли игроку заложить покрытие в тайл: внутри карты, не в чужой зоне и не у подножия обрыва; на тайле нет работы
-- над покрытием, а готовое покрытие — разве что своё другого вида: фундамент меняют на дорогу и обратно, и прежнее
-- действует, пока новое не готово. Фундамент — на скале или песке, дорога — где угодно, кроме гор. Дорогу кладут только
-- на свободное от зданий и площадок, фундамент — и под свои здания и площадки: строители кладут его с края. Своей зоны
-- покрытию не нужно. all — зоны (zones.all), чтобы не собирать их на каждый тайл.
function paving.canPave(w, player: number, kind: string, x: number, y: number, all: { [number]: { number } }?): boolean
	if x ~= math.floor(x) or y ~= math.floor(y) or not paving.CODE[kind] or not enabled(w) then
		return false
	end
	local size = w.game.data and w.game.data.size
	if size and (x < -size or y < -size or x >= size or y >= size) then
		return false
	end
	local terrain, _, foot = w:terrain(x, y)
	if kind == "foundation" then
		if terrain ~= ROCK and terrain ~= SAND then
			return false
		end
	elseif terrain == MOUNTAIN then
		return false
	end
	-- У подножия обрыва стоит его стенка: класть туда нельзя, как и строить.
	if foot then
		return false
	end
	-- Покрытие открывают исследования: фундамент, дороги, а дорогу по болоту — мосты.
	if not construction.researched(w, player, paving.RESEARCH[if kind == "road" and terrain == SWAMP then "bridge" else kind]) then
		return false
	end
	if at(w, x, y) then
		return false
	end
	local present, owner = laid(w, x, y)
	if present and (present == kind or owner ~= player) then
		return false
	end
	local standing = standingAt(w, x, y)
	if standing and (kind ~= "foundation" or not isOwn(w, player, standing)) then
		return false
	end
	return not zones.inForeign(w, player, x, y, 1, 1, all)
end

-- Своё здание или стройка в тайле, основание которого целиком лежит в covered («x:y» → true); нет — nil. Главное здание
-- и то, что уже разбирают, не в счёт.
function paving.buildingWithin(w, player: number, x: number, y: number, covered: { [string]: boolean }, core): number?
	local e = standingAt(w, x, y)
	if not e or not isOwn(w, player, e) or not w:has(e, "Building") then
		return nil
	end
	local site = w:get(e, "Site")
	if (site and site.demolish) or kinds.is(w, e, core) then
		return nil
	end
	local size = w:get(e, "Building")
	local left, top = construction.corner(w, e)
	for ty = top, top + size.height - 1 do
		for tx = left, left + size.width - 1 do
			if not covered[tx .. ":" .. ty] then
				return nil
			end
		end
	end
	return e
end

-- Снимается ли что-нибудь своё с тайла инструментом «Снять»: покрытие — недостроенное или готовое, которое ещё не
-- разбирают, — труба с колодцем или здание, целиком попавшее в рамку.
function paving.removable(w, player: number, x: number, y: number, covered: { [string]: boolean }, core): boolean
	local e = at(w, x, y)
	if e then
		if isOwn(w, player, e) and not w:get(e, "Pave").remove then
			return true
		end
	elseif ownerAt(w, x, y) == player then
		return true
	end
	return construction.pipeAt(w, player, x, y) ~= nil or paving.buildingWithin(w, player, x, y, covered, core) ~= nil
end

-- Во сколько раз быстрее голой скалы строится здание вида kind с левым верхним тайлом (x, y): по самому медленному
-- тайлу основания. Фундамент на скале ускоряет, на песке — разрешает стройку, но чуть медленнее скалы.
function paving.buildSpeed(w, kind, x: number, y: number): number
	if not enabled(w) then
		return 1
	end
	local speed = math.huge
	for ty = y, y + kind.data.height - 1 do
		for tx = x, x + kind.data.width - 1 do
			if not paving.isPaved(w, "foundation", tx, ty) then
				speed = math.min(speed, 1)
			else
				speed = math.min(speed, if w:terrain(tx, ty) == SAND then paving.FOUNDATION_SAND else paving.FOUNDATION_ROCK)
			end
		end
	end
	return if speed == math.huge then 1 else speed
end

-- Хосту: кладёт в слой готовое покрытие вида kind хозяина owner (lay); прежнее покрытие тайла уходит.
function paving.lay(ctx, x: number, y: number, kind: string, owner: number)
	ctx:set_layer("paving", x, y, paving.CODE[kind])
	ctx:set_layer("paving", x, y, owner, 1)
end

-- Хосту: убирает готовое покрытие с тайла (lift).
function paving.lift(ctx, x: number, y: number)
	ctx:set_layer("paving", x, y, 0)
	ctx:set_layer("paving", x, y, 0, 1)
end

-- Хосту: заводит работу над покрытием посреди тайла (x, y) — укладку или разбор (поля Pave). Номер известен сразу,
-- а сущность появится после системы или приказа.
function paving.open(ctx, player: number, x: number, y: number, pave: { [string]: any }): number
	local e = ctx:spawn(nil, { Position = { x = x + 0.5, y = y + 0.5 }, Pave = pave, Owner = { player = player } })
	ctx:set_layer("paveWork", x, y, e)
	return e
end

-- Хосту: работа над покрытием кончилась или отменена — её больше нет на тайле.
function paving.forget(ctx, e: number)
	local x, y = surface.tileOf(ctx, e)
	if ctx:layer("paveWork", x, y) == e then
		ctx:set_layer("paveWork", x, y, 0)
	end
	ctx:destroy(e)
end

-- Наземный взрыв меньше этого — пуля: фундамент от неё не трескается.
paving.SLAB_BLAST = 0.5

-- Хосту: наземный взрыв размером size разбивает фундамент — плиты, чьи центры в его радиусе, и ту, на которую он
-- пришёлся; с готовой плитой уходит и работа над ней — укладка или разбор.
function paving.breakSlabs(ctx, x: number, y: number, size: number)
	if size < paving.SLAB_BLAST or not enabled(ctx) then
		return
	end
	local radius = size / 2
	for tileY = math.floor(y - radius), math.floor(y + radius) do
		for tileX = math.floor(x - radius), math.floor(x + radius) do
			local hit = tileX == math.floor(x) and tileY == math.floor(y)
			local dx, dy = tileX + 0.5 - x, tileY + 0.5 - y
			if not hit and math.sqrt(dx * dx + dy * dy) > radius then
				continue
			end
			if paving.isPaved(ctx, "foundation", tileX, tileY) then
				paving.lift(ctx, tileX, tileY)
			end
			local e = at(ctx, tileX, tileY)
			if e and ctx:get(e, "Pave").kind == "foundation" then
				paving.forget(ctx, e)
			end
		end
	end
end

return paving
