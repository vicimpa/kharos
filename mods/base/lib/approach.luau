--!strict
-- Подъезд на длину луча — перенос approach и gapBetween из inventory.ts: юнит встаёт так, чтобы между ним и зданием,
-- площадкой или другим юнитом дотянулся луч длиной radius, — на ближайший к нему свободный тайл, откуда хватает и куда
-- можно доехать. Вплотную ему не нужно. Только хосту: прокладывает пути.

local placement = require("lib/placement")
local construction = require("lib/construction")

local approach = {}

-- На сколько тайлов ближе радиуса луча встаёт подъезжающий: с запасом на неточную остановку (APPROACH_MARGIN).
approach.MARGIN = 0.5
-- Сколько мест пробуется, прежде чем сдаться (APPROACH_TRIES).
approach.TRIES = 4
-- Карман — замкнутый пятачок меньше стольких тайлов: места в чужом кармане не пробуются (POCKET).
approach.POCKET = 48
-- В каком поле вокруг цели стоящие не мешают пути к ней, если иначе не проехать (ASIDE_REACH).
approach.ASIDE = 6
-- Половина окна поиска пути: цель дальше — путь доходит лишь до края окна (beyondWindow).
local HALF_WINDOW = 256

export type Shape = { left: number, top: number, width: number, height: number, radius: number, x: number, y: number }

-- Что сущность занимает (shapeOf): основание здания или площадки, круг юнита. x, y — середина.
function approach.shape(w, e: number): Shape?
	local at = w:get(e, "Position")
	if not at then
		return nil
	end
	local size = w:get(e, "Building")
	if size then
		return { left = placement.left(at.x, size.width), top = placement.left(at.y, size.height), width = size.width, height = size.height, radius = 0, x = at.x, y = at.y }
	end
	local mover = w:get(e, "Mover")
	return { left = at.x, top = at.y, width = 0, height = 0, radius = if mover then mover.radius else 0, x = at.x, y = at.y }
end

-- Расстояние между краями двух сущностей (gapBetween); вплотную и внахлёст — ноль.
function approach.gap(w, a: number, b: number): number
	local one, two = approach.shape(w, a), approach.shape(w, b)
	if not one or not two then
		return math.huge
	end
	local dx = math.max(0, one.left - two.left - two.width, two.left - one.left - one.width)
	local dy = math.max(0, one.top - two.top - two.height, two.top - one.top - one.height)
	return math.max(0, math.sqrt(dx * dx + dy * dy) - one.radius - two.radius)
end

-- Тайлы, где стоят юниты, кроме ignore (standingUnits): radius — запас вокруг.
local function standing(ctx, ignore: number, radius: number): { [string]: boolean }
	local tiles = {}
	for _, e in ctx:each({ "Unit", "Position", "Mover" }) do
		local mover = ctx:get(e, "Mover")
		if e == ignore or mover.class == "air" or ctx:has(e, "Path") then
			continue
		end
		local at = ctx:get(e, "Position")
		local reach = mover.radius + radius
		for y = math.floor(at.y - reach), math.floor(at.y + reach) do
			local dy = y + 0.5 - at.y
			for x = math.floor(at.x - reach), math.floor(at.x + reach) do
				local dx = x + 0.5 - at.x
				if dx * dx + dy * dy < reach * reach then
					tiles[x .. ":" .. y] = true
				end
			end
		end
	end
	return tiles
end

-- Подводит юнит e к цели target на луч длиной radius (approach). Возвращает, нашлось ли место, куда доехать.
function approach.go(ctx, e: number, target: number, radius: number): boolean
	local at = ctx:get(e, "Position")
	local mover = ctx:get(e, "Mover")
	local shape = approach.shape(ctx, target)
	if not at or not mover or not shape or target == e then
		return false
	end
	-- Юнит — квадрат вокруг своего круга: к нему подъезжают, где он стоит сейчас.
	local left = if shape.radius > 0 then shape.x - shape.radius else shape.left
	local top = if shape.radius > 0 then shape.y - shape.radius else shape.top
	local width = if shape.width > 0 then shape.width else shape.radius * 2
	local height = if shape.height > 0 then shape.height else shape.radius * 2
	local size = mover.radius
	local reach = math.max(0, radius - approach.MARGIN)
	local taken = standing(ctx, e, size)
	local span = math.ceil(reach + size)
	local foot = mover.class == "infantry"
	-- Места в радиусе луча: сначала свободные, ближние к юниту — раньше; занятое стоящим годится, если свободных нет.
	local places = {}
	for y = math.floor(top - span), math.ceil(top + height + span) - 1 do
		for x = math.floor(left - span), math.ceil(left + width + span) - 1 do
			local dx = math.max(0, left - x - 0.5, x + 0.5 - left - width)
			local dy = math.max(0, top - y - 0.5, y + 0.5 - top - height)
			if math.sqrt(dx * dx + dy * dy) - size > reach then
				continue
			end
			if not ctx:walkable(x, y, foot) or construction.siteAt(ctx, x, y) then
				continue
			end
			local distance = math.sqrt((x + 0.5 - at.x) ^ 2 + (y + 0.5 - at.y) ^ 2)
			table.insert(places, { x = x, y = y, order = distance + (if taken[x .. ":" .. y] then 1e6 else 0) })
		end
	end
	table.sort(places, function(a, b)
		return a.order < b.order
	end)
	local fromX, fromY = math.floor(at.x), math.floor(at.y)
	-- Ведёт юнит в место; удалось — путь доходит до самого места или юнит уже там.
	local function goTo(x: number, y: number, ignore: { number }?): boolean
		if fromX == x and fromY == y then
			return true
		end
		ctx:move(e, x, y, 0, ignore)
		local path = ctx:get(e, "Path")
		local points = path and path.points
		if math.abs(x - fromX) >= HALF_WINDOW - 1 or math.abs(y - fromY) >= HALF_WINDOW - 1 then
			return points ~= nil and #points > 0
		end
		return points ~= nil and #points >= 2 and math.floor(points[#points - 1]) == x and math.floor(points[#points]) == y
	end
	-- Места в чужом кармане не пробуются: соседние места кармана — в одной заливке, её не повторять.
	local tries = {}
	local pockets: { { x: number, y: number, size: number, home: boolean } } = {}
	for _, place in places do
		if #tries >= approach.TRIES then
			break
		end
		local open = nil
		for _, pocket in pockets do
			if pocket.size < approach.POCKET then
				-- Тот же карман: заливка из места касается прежнего места.
				local _, same = ctx:reach(pocket.x, pocket.y, approach.POCKET, place.x, place.y)
				if same then
					open = pocket.home
					break
				end
			end
		end
		if open == nil then
			local count, home = ctx:reach(place.x, place.y, approach.POCKET, fromX, fromY)
			table.insert(pockets, { x = place.x, y = place.y, size = count, home = count >= approach.POCKET or home })
			open = count >= approach.POCKET or home
		end
		if open then
			table.insert(tries, place)
		end
	end
	for _, place in tries do
		if goTo(place.x, place.y) then
			return true
		end
	end
	-- Проход загородили стоящие: путь — сквозь них, подъехав, юнит попросит их посторониться.
	local near = { e }
	local field = span + math.max(width, height) + approach.ASIDE
	for _, other in ctx:near(left + width / 2, top + height / 2, field, { "Unit" }) do
		if other ~= e then
			table.insert(near, other)
		end
	end
	for _, place in tries do
		if goTo(place.x, place.y, near) then
			return true
		end
	end
	ctx:stop(e)
	return false
end

return approach
