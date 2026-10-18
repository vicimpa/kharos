--!strict
-- Зоны строительства — круги вокруг готовых зданий игрока (zoneOf и inForeignZone в zones.ts): у здания со своей
-- зоной (data.zone) — она, у остальных — data.expand или EXPAND_RADIUS. Стена и ворота (data.isolated) зону не
-- расширяют, площадки и здания под разбором — тоже. Связность сетей (трубы, стыки одинаковых зданий) и энергосети —
-- Б4: стройке нужны только круги, а они у всех сетей игрока одни и те же. Годится и хосту (ctx), и клиенту (c).

local kinds = require("lib/kinds")

local zones = {}

-- На сколько тайлов от своего центра расширяет зону готовое здание без своего радиуса (EXPAND_RADIUS).
zones.EXPAND_RADIUS = 5

-- Круги зон всех игроков: игрок → { x, y, радиус, … } подряд. Позиция здания — его середина.
function zones.all(w): { [number]: { number } }
	local result: { [number]: { number } } = {}
	for _, e in w:each({ "Building", "Owner", "Position" }) do
		if w:has(e, "Site") or not w:has(e, "Footprint") then
			continue
		end
		local kind = kinds.of(w, e)
		local data = kind and kind.data
		if not data or data.isolated then
			continue
		end
		local player = w:get(e, "Owner").player
		local at = w:get(e, "Position")
		local list = result[player]
		if not list then
			list = {}
			result[player] = list
		end
		table.insert(list, at.x)
		table.insert(list, at.y)
		table.insert(list, data.zone or data.expand or zones.EXPAND_RADIUS)
	end
	return result
end

-- Попадает ли точка хотя бы в один круг; circles — x, y и радиус подряд.
function zones.inCircles(circles: { number }?, x: number, y: number): boolean
	if not circles then
		return false
	end
	for i = 1, #circles, 3 do
		local dx, dy = x - circles[i], y - circles[i + 1]
		if math.sqrt(dx * dx + dy * dy) <= circles[i + 2] then
			return true
		end
	end
	return false
end

-- Задевает ли основание (левый верхний тайл x, y) чужую зону: центр или углы в чужом круге. Где зоны двух игроков
-- перекрываются, не строит ни один.
function zones.inForeign(w, player: number, x: number, y: number, width: number, height: number, all: { [number]: { number } }?): boolean
	for other, circles in all or zones.all(w) do
		if other == player then
			continue
		end
		if zones.inCircles(circles, x + width / 2, y + height / 2) then
			return true
		end
		for _, corner in { { x, y }, { x + width, y }, { x, y + height }, { x + width, y + height } } do
			if zones.inCircles(circles, corner[1], corner[2]) then
				return true
			end
		end
	end
	return false
end

-- Попадает ли центр основания с левым верхним тайлом (x, y) в зону строительства игрока (inControl).
function zones.inControl(w, player: number, x: number, y: number, width: number, height: number, all: { [number]: { number } }?): boolean
	return zones.inCircles((all or zones.all(w))[player], x + width / 2, y + height / 2)
end

return zones
