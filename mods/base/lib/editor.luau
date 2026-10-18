--!strict
-- Редактор сохранений, запросы, общие хосту (ctx) и клиенту (c): тайлы кисти, что под точкой, месторождения под точкой
-- и в рамке, можно ли туда положить месторождение, турели носителя. Правят мир — приказы `edit` (mechanics/editor),
-- подача — ui/editor и controls/editor.

local deposits = require("lib/deposits")
local kinds = require("lib/kinds")

local editor = {}

-- Самый большой радиус вершины, при котором все её тайлы укладываются в смещение до 4 тайлов.
editor.MAX_PEAK_RADIUS = 2.75
-- Какую долю тайлов круга красит разброс.
editor.SPRAY_SHARE = 0.3

local MOUNTAIN = 3

-- Тайлы кисти размера size с серединой в тайле (x, y), x и y подряд; shape — square, circle или spray. random — случай
-- разброса (на хосте — ctx:random).
function editor.brushTiles(x: number, y: number, size: number, shape: string?, random: (() -> number)?): { number }
	local tiles = {}
	local from = math.floor(size / 2)
	local radius = size / 2
	for tileY = y - from, y - from + size - 1 do
		for tileX = x - from, x - from + size - 1 do
			local inside = shape == nil or shape == "square" or math.sqrt((tileX - x) ^ 2 + (tileY - y) ^ 2) <= radius - 0.25 or size == 1
			if inside and (shape ~= "spray" or (random or math.random)() < editor.SPRAY_SHARE or size == 1) then
				table.insert(tiles, tileX)
				table.insert(tiles, tileY)
			end
		end
	end
	return tiles
end

-- Внутри ли тайл карты.
function editor.inside(w, x: number, y: number): boolean
	local size = w.game.data and w.game.data.size
	return size ~= nil and x >= -size and y >= -size and x < size and y < size
end

-- Тайл для подписи в панели: вид, биом, ярус (у горы — nil), обрыв и подножие.
function editor.describeTile(w, x: number, y: number)
	local terrain, biome, foot = w:terrain(x, y)
	local _, _, _, relief = w:tile(x, y)
	if terrain == nil then
		return nil
	end
	local mountain = terrain == MOUNTAIN
	return { terrain = terrain, biome = biome, tier = if mountain then nil else bit32.band(relief or 0, 3), cliff = not mountain and bit32.band(relief or 0, 4) ~= 0, foot = foot == true }
end

-- Что под точкой (x, y) для редактора: юнит, если он там стоит, иначе здание или площадка.
function editor.entityAt(w, x: number, y: number): number?
	local best, nearest = nil, math.huge
	for _, e in w:each({ "Mover", "Position" }) do
		if w:has(e, "Attached") then
			continue
		end
		local at = w:get(e, "Position")
		local distance = math.sqrt((at.x - x) ^ 2 + (at.y - y) ^ 2)
		if distance <= math.max(0.5, w:get(e, "Mover").radius) and distance < nearest then
			best, nearest = e, distance
		end
	end
	if best then
		return best
	end
	local tx, ty = math.floor(x), math.floor(y)
	local found = w:occupant(tx, ty)
	if found then
		return found
	end
	for _, e in w:each({ "Site", "Building", "Position" }) do
		local size, at = w:get(e, "Building"), w:get(e, "Position")
		local left, top = math.round(at.x - size.width / 2), math.round(at.y - size.height / 2)
		if tx >= left and tx < left + size.width and ty >= top and ty < top + size.height then
			return e
		end
	end
	return nil
end

-- Месторождение: сущность, левый верхний тайл, вид и сколько осталось.
export type Spot = { entity: number, x: number, y: number, kind: string, left: number }

local function spotOf(w, e: number): Spot?
	local at, deposit, kind = w:get(e, "Position"), w:get(e, "Deposit"), kinds.of(w, e)
	if not at or not deposit or not kind then
		return nil
	end
	return { entity = e, x = at.x - deposits.SIZE / 2, y = at.y - deposits.SIZE / 2, kind = kind.name, left = deposit.reserve }
end

-- Месторождение с левым верхним тайлом ровно в (x, y).
function editor.depositAt(w, x: number, y: number): Spot?
	for _, e in w:each({ "Deposit", "Position" }) do
		local spot = spotOf(w, e)
		if spot and spot.x == x and spot.y == y then
			return spot
		end
	end
	return nil
end

-- Месторождение под точкой (x, y): то, на чьи тайлы она попала.
function editor.depositUnder(w, x: number, y: number): Spot?
	for _, e in w:each({ "Deposit", "Position" }) do
		local spot = spotOf(w, e)
		if spot and x >= spot.x and x < spot.x + deposits.SIZE and y >= spot.y and y < spot.y + deposits.SIZE then
			return spot
		end
	end
	return nil
end

-- Месторождения, середина которых в прямоугольнике в тайлах.
function editor.depositsInBox(w, left: number, top: number, right: number, bottom: number): { Spot }
	local found = {}
	for _, e in w:each({ "Deposit", "Position" }) do
		local at = w:get(e, "Position")
		if at.x >= left and at.x <= right and at.y >= top and at.y <= bottom then
			table.insert(found, spotOf(w, e))
		end
	end
	return found
end

-- Можно ли положить месторождение левым верхним тайлом в (x, y): там, где встала бы шахта, — скала не у подножия
-- обрыва, — и не внахлёст с другим. ignore — сущности месторождений, которые переносят.
function editor.canPutDeposit(w, x: number, y: number, ignore: { [number]: boolean }?): boolean
	local size = w.game.data and w.game.data.size
	if not size or x < -size or y < -size or x + deposits.SIZE > size or y + deposits.SIZE > size then
		return false
	end
	for _, e in w:each({ "Deposit", "Position" }) do
		if ignore and ignore[e] then
			continue
		end
		local spot = spotOf(w, e)
		if spot and math.abs(spot.x - x) < deposits.SIZE and math.abs(spot.y - y) < deposits.SIZE then
			return false
		end
	end
	for tileY = y, y + deposits.SIZE - 1 do
		for tileX = x, x + deposits.SIZE - 1 do
			local terrain, _, foot = w:terrain(tileX, tileY)
			if terrain ~= 2 or foot then
				return false
			end
		end
	end
	return true
end

-- Юниты и здания, середина которых в прямоугольнике в тайлах; турели — нет: они на носителе.
function editor.entitiesIn(w, left: number, top: number, right: number, bottom: number): { number }
	local found = {}
	for _, e in w:each({ "Position", "Owner" }) do
		if w:has(e, "Attached") or not (w:has(e, "Building") or w:has(e, "Mover")) then
			continue
		end
		local at = w:get(e, "Position")
		if at.x >= left and at.x <= right and at.y >= top and at.y <= bottom then
			table.insert(found, e)
		end
	end
	return found
end

-- Турели носителя по порядку креплений.
function editor.turretsOf(w, e: number): { number }
	local list = {}
	for _, turret in w:each({ "Attached" }) do
		if w:get(turret, "Attached").parent == e then
			table.insert(list, turret)
		end
	end
	table.sort(list)
	return list
end

-- Куда смотрит каждая турель носителя, в радианах на карте.
function editor.turretFacings(w, e: number): { number }
	local base = w:get(e, "Facing")
	local list = {}
	for _, turret in editor.turretsOf(w, e) do
		table.insert(list, (if base then base.angle else 0) + w:get(turret, "Attached").angle)
	end
	return list
end

-- Игроки мира по возрастанию номера.
function editor.players(w): { number }
	local seen, list = {}, {}
	local function add(id: number)
		if id and id > 0 and not seen[id] then
			seen[id] = true
			table.insert(list, id)
		end
	end
	for _, e in w:each({ "Player" }) do
		add(w:get(e, "Player").id)
	end
	for _, e in w:each({ "Owner" }) do
		add(w:get(e, "Owner").player)
	end
	table.sort(list)
	return list
end

-- Камера игрока в начале игры: { x, y, zoom }; nil — не задана.
function editor.camera(w, player: number)
	for _, e in w:each({ "Player" }) do
		local state = w:get(e, "Player")
		if state.id == player and type(state.camera) == "table" and #state.camera == 3 then
			return { x = state.camera[1], y = state.camera[2], zoom = state.camera[3] }
		end
	end
	return nil
end

return editor
