--!strict
-- Разворачивание MCV и сворачивание главного здания — правила из conversion.ts, общие для хоста (ctx) и клиента (c):
-- где встанет здание, можно ли туда развернуться, ждёт ли MCV, пока уйдут юниты. Что во что превращается и сколько
-- длится — data механики mechanics/conversion.

local placement = require("lib/placement")
local zones = require("lib/zones")

local conversion = {}

-- Данные механики: что во что превращается и сроки.
function conversion.data(w)
	return w.protos.mechanics.conversion.data
end

-- Вид юнита, который разворачивается, и вид здания, в которое.
function conversion.unit(w)
	return w.protos.units[conversion.data(w).unit]
end

function conversion.building(w)
	return w.protos.buildings[conversion.data(w).building]
end

local function isKind(w, e: number, kind): boolean
	local proto = w:get(e, "Proto")
	return proto ~= nil and kind ~= nil and proto.id == kind.id
end

local function owns(w, player: number, e: number): boolean
	local owner = w:get(e, "Owner")
	return owner ~= nil and owner.player == player
end

-- Где встанет главное здание, если MCV развернётся на месте: левый верхний тайл основания (siteUnder).
function conversion.siteUnder(w, e: number): (number, number)
	local at = w:get(e, "Position")
	local data = conversion.building(w).data
	return math.floor(at.x) - math.floor(data.width / 2), math.floor(at.y) - math.floor(data.height / 2)
end

-- Где встанет главное здание: куда MCV послан разворачиваться, а не послан — под ним (deploySite).
function conversion.site(w, e: number): (number, number)
	local deploys = w:get(e, "Deploys")
	if deploys then
		return deploys.x, deploys.y
	end
	return conversion.siteUnder(w, e)
end

-- Можно ли послать этот MCV разворачиваться: это MCV игрока, и он ещё не разворачивается (canSendDeploy).
function conversion.canSend(w, player: number, e: number): boolean
	return isKind(w, e, conversion.unit(w)) and owns(w, player, e) and not w:has(e, "Converting")
end

-- Может ли MCV развернуться главным зданием с левым верхним тайлом (x, y) (canDeployAt): место годится и не задевает
-- чужую зону.
function conversion.canDeployAt(w, player: number, e: number, x: number, y: number): boolean
	local building = conversion.building(w)
	if not conversion.canSend(w, player, e) or not placement.canPlace(w, building, x, y) then
		return false
	end
	return not zones.inForeign(w, player, x, y, building.data.width, building.data.height)
end

-- Может ли игрок развернуть этот MCV прямо на месте (canDeploy).
function conversion.canDeploy(w, player: number, e: number): boolean
	if not conversion.canSend(w, player, e) then
		return false
	end
	local x, y = conversion.siteUnder(w, e)
	return conversion.canDeployAt(w, player, e, x, y)
end

-- Может ли игрок свернуть это здание: это его главное здание, и оно не сворачивается уже (canPack).
function conversion.canPack(w, player: number, e: number): boolean
	return isKind(w, e, conversion.building(w)) and owns(w, player, e) and not w:has(e, "Converting")
end

-- Ждёт ли MCV, пока из-под будущего здания уйдут юниты: время вышло, а место занято (isDeployBlocked).
function conversion.blocked(w, e: number): boolean
	local converting = w:get(e, "Converting")
	return converting ~= nil and w:has(e, "Unit") and converting.left <= 0
end

-- Свёрнутая ли это база: машина с очередью главного здания; очередь у неё стоит (isPacked).
function conversion.packed(w, e: number): boolean
	return w:has(e, "Unit") and w:has(e, "Producer")
end

-- Другой принятый приказ отменяет поездку MCV на разворачивание (accept в commands.ts); разворачивающегося — нет.
function conversion.forget(ctx, units: { number })
	for _, e in units do
		if ctx:has(e, "Deploys") and not ctx:has(e, "Converting") then
			ctx:remove(e, "Deploys")
		end
	end
end

return conversion
