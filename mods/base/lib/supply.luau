--!strict
-- Магазины, общий хосту и клиенту. У юнита с data.ammo магазин (Magazine движка): выстрел каждого ствола тратит свою
-- долю (Armed.cost), пустой юнит молчит. Полного магазина хватает на magazineSeconds непрерывного огня всеми стволами,
-- у пехоты — на infantrySeconds. Турели зданий с data.ammo стреляют со склада: их выстрел стоит weapon.data.ammo.
-- Правило партии unitAmmo = false — юниты стреляют бесплатно.

local supply = {}

-- На сколько секунд непрерывного огня всеми стволами хватает полного магазина; у пехоты запас больше, чтобы ответом на
-- снабжение не стала толпа пехоты.
supply.MAGAZINE_SECONDS = 50
supply.INFANTRY_MAGAZINE_SECONDS = 120
-- Сколько боеприпасов в секунду юнит набирает в своей сети, сколько грузит машина снабжения из хранилищ сети.
supply.REFILL_RATE = 10
supply.SUPPLIER_LOAD = 10
local EPSILON = 1e-9

-- Включено ли правило боеприпасов юнитов; по умолчанию — да.
function supply.enabled(w): boolean
	local rules = w.game and w.game.data and w.game.data.rules
	return not rules or rules.unitAmmo ~= false
end

-- Оружие стволов юнита: своё и турелей на нём.
local function weaponsOf(kind, protos): { any }
	local list = {}
	local data = kind.data
	if data.weapon and protos.weapons[data.weapon] then
		table.insert(list, protos.weapons[data.weapon])
	end
	for _, mount in data.mounts or {} do
		local turret = protos.turrets[mount.turret]
		local weapon = turret and turret.data.weapon and protos.weapons[turret.data.weapon]
		if weapon then
			table.insert(list, weapon)
		end
	end
	return list
end

-- Сколько боеприпасов в полном магазине юнита; ноль — стреляет бесплатно.
function supply.magazineOf(kind): number
	return kind.data.ammo or 0
end

-- Сколько боеприпасов тратит выстрел юнита этим оружием: магазин делится на секунды огня всех стволов.
function supply.shotCost(kind, protos, weapon): number
	local capacity = supply.magazineOf(kind)
	if capacity == 0 then
		return 0
	end
	local seconds = if kind.data.kind == "infantry" then supply.INFANTRY_MAGAZINE_SECONDS else supply.MAGAZINE_SECONDS
	return capacity * weapon.data.reload / (seconds * math.max(1, #weaponsOf(kind, protos)))
end

-- Самый дешёвый выстрел юнита: меньше этого в магазине — юнит пуст.
function supply.cheapest(kind, protos): number
	local least = math.huge
	for _, weapon in weaponsOf(kind, protos) do
		least = math.min(least, supply.shotCost(kind, protos, weapon))
	end
	return if least == math.huge then 0 else least
end

-- Цена выстрела ствола на носителе вида carrier оружием weapon: у юнита — доля магазина, у здания — weapon.data.ammo,
-- если здание стреляет со склада (data.ammo).
function supply.costOn(carrier, protos, weapon): number
	if carrier.section == "buildings" then
		return if carrier.data.ammo then weapon.data.ammo or 0 else 0
	end
	return supply.shotCost(carrier, protos, weapon)
end

-- Сколько боеприпасов в магазине юнита.
function supply.ammoOf(w, e: number): number
	local magazine = w:get(e, "Magazine")
	return if magazine then magazine.ammo else 0
end

-- Пуст ли магазин юнита: не хватает на самый дешёвый его выстрел. Без магазина — не пуст.
function supply.isEmpty(w, e: number): boolean
	local magazine = w:get(e, "Magazine")
	return magazine ~= nil and magazine.least > 0 and magazine.ammo < magazine.least - EPSILON
end

-- Расстояние от точки до прямоугольника: внутри — ноль.
function supply.gap(cx: number, cy: number, x: number, y: number, width: number, height: number): number
	return math.sqrt(math.max(x - cx, 0, cx - x - width) ^ 2 + math.max(y - cy, 0, cy - y - height) ^ 2)
end

-- Попадает ли точка хотя бы в один круг сети: circles — x, y и радиус подряд.
function supply.inCircles(circles: { number }, x: number, y: number): boolean
	for i = 1, #circles, 3 do
		if (x - circles[i]) ^ 2 + (y - circles[i + 1]) ^ 2 <= circles[i + 2] ^ 2 then
			return true
		end
	end
	return false
end

return supply
