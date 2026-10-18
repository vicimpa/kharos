--!strict
-- Место под здание — перенос canPlace из buildings.ts: внутри карты, на скале (оборону и трубы — и на песке), не у
-- подножия обрыва, тайлы и полоса gap вокруг не заняты зданиями. Годится и хосту (ctx), и клиенту (c): обоим нужны
-- только :terrain, :occupant, :each, :layer и game.data.size. Готовый фундамент делает песок пригодным для любого
-- здания; на дороге — и на той, что кладут, — не строят ничего (lib/surface).

local surface = require("lib/surface")

local placement = {}

-- Виды местности ctx:terrain.
local SAND, ROCK = 1, 2

-- Можно ли поставить здание вида kind с левым верхним тайлом (x, y); gap — свободная полоса вокруг.
function placement.canPlace(w, kind, x: number, y: number, gap: number?): boolean
	if x ~= math.floor(x) or y ~= math.floor(y) then
		return false
	end
	local data = kind.data
	local width, height = data.width, data.height
	local size = w.game.data and w.game.data.size
	if size and (x < -size or y < -size or x + width > size or y + height > size) then
		return false
	end
	local sandy = data.defense or data.pipe
	for tileY = y, y + height - 1 do
		for tileX = x, x + width - 1 do
			local terrain, _, foot = w:terrain(tileX, tileY)
			-- У подножия обрыва стоит его стенка: здание на ней смотрелось бы как танк на стене.
			if terrain and (foot or not (terrain == ROCK or (sandy and terrain == SAND) or (terrain == SAND and surface.isPaved(w, "foundation", tileX, tileY)))) then
				return false
			end
			-- Дорога — для транспорта: на ней и на той, что кладут, не строят ничего, даже трубу.
			if surface.isRoadway(w, tileX, tileY) then
				return false
			end
		end
	end
	local around = gap or 0
	for tileY = y - around, y + height + around - 1 do
		for tileX = x - around, x + width + around - 1 do
			if w:occupant(tileX, tileY) then
				return false
			end
		end
	end
	-- Площадка, которую ещё не начали строить, тайлов не занимает, но место за ней уже закреплено.
	for _, e in w:each({ "Site", "Building", "Position" }) do
		local other = w:get(e, "Building")
		local at = w:get(e, "Position")
		local left, top = placement.left(at.x, other.width), placement.left(at.y, other.height)
		if x - around < left + other.width and x + width + around > left and y - around < top + other.height and y + height + around > top then
			return false
		end
	end
	return true
end

-- Середина здания шириной width с левым краем left: так стоит Position здания.
function placement.middle(left: number, width: number): number
	return left + width / 2
end

-- Левый край здания шириной width с серединой x (Occupancy::tiles_of).
function placement.left(x: number, width: number): number
	return math.round(x - width / 2)
end

return placement
