--!strict
-- Груз на земле — перенос drops.ts, общий хосту (ctx) и клиенту (c). Дроп — груз, брошенный на землю: что лежало на
-- складе разрушенного или разобранного здания, в кузове погибшей машины, на отменённой стройке. Это склад без здания на
-- одном тайле и без хозяина (Drop, Inventory, Position посреди тайла): подобрать его может любой грузовик, а свободные
-- везут его в хранилище, руду — на переработку (mechanics/hauling). Пустой дроп исчезает, стройка или развёрнутый MCV
-- поверх дропа его уничтожают.

local goods = require("lib/goods")

local drops = {}

local EPSILON = goods.EPSILON

-- Брошенное в этом тике: новый дроп появится в мире только после системы, а второй груз на тот же тайл ляжет к нему.
local pending: { tick: number, at: { [string]: { entity: number, items: { [string]: number } } } } = { tick = -1, at = {} }

-- Дроп ли это: лежащий на земле груз.
function drops.is(w, e: number): boolean
	return w:has(e, "Drop")
end

-- Дроп на тайле или nil (dropAt). Дропов немного, поэтому простой перебор.
function drops.at(w, x: number, y: number): number?
	for _, e in w:each({ "Drop", "Position" }) do
		local at = w:get(e, "Position")
		if math.floor(at.x) == x and math.floor(at.y) == y then
			return e
		end
	end
	return nil
end

-- Бросает груз на тайл под точкой (x, y): к дропу, который уже там лежит, или новым дропом (dropItems). Пустое не
-- бросают. Дроп принимает только то, что на него бросили: места ровно под груз. Возвращает дроп или nil.
function drops.put(w, x: number, y: number, items: { [string]: number }): number?
	local any = false
	for _, amount in items do
		any = any or amount > EPSILON
	end
	if not any then
		return nil
	end
	local tileX, tileY = math.floor(x), math.floor(y)
	if pending.tick ~= w.tick then
		pending.tick, pending.at = w.tick, {}
	end
	local key = tileX .. ":" .. tileY
	local fresh = pending.at[key]
	if not fresh then
		local found = drops.at(w, tileX, tileY)
		local stock = found and w:get(found, "Inventory")
		local items = {}
		for good, amount in if stock then stock.items else {} do
			items[good] = amount
		end
		fresh = { entity = found or w:spawn(nil, { Position = { x = tileX + 0.5, y = tileY + 0.5 }, Drop = {}, Inventory = {} }), items = items }
		pending.at[key] = fresh
	end
	for good, amount in items do
		if amount > EPSILON then
			fresh.items[good] = (fresh.items[good] or 0) + amount
		end
	end
	local load = 0
	for _, amount in fresh.items do
		load += amount
	end
	w:set(fresh.entity, "Inventory", { items = table.clone(fresh.items), capacity = load })
	return fresh.entity
end

-- Бросает весь груз сущности на землю под ней (dropCargo): у здания — на тайл в середине основания, у юнита — на его
-- тайл. remains — её компоненты, когда самой её уже нет (событие killed). Дроп груз не роняет.
function drops.cargo(w, e: number, remains: { [string]: any }?)
	local function get(name: string)
		if remains then
			return remains[name]
		end
		return w:get(e, name)
	end
	local stock, at = get("Inventory"), get("Position")
	if not stock or not at or get("Drop") then
		return
	end
	drops.put(w, at.x, at.y, stock.items)
end

-- Уничтожает дропы под основанием, на котором встаёт здание (clearDrops): left, top — угол, тайлы.
function drops.clear(w, left: number, top: number, width: number, height: number)
	for _, e in w:each({ "Drop", "Position" }) do
		local at = w:get(e, "Position")
		local x, y = math.floor(at.x), math.floor(at.y)
		if x >= left and x < left + width and y >= top and y < top + height then
			w:destroy(e)
		end
	end
	if pending.tick == w.tick then
		for key, fresh in pending.at do
			local x, y = string.match(key, "^(-?%d+):(-?%d+)$")
			local tileX, tileY = tonumber(x) :: number, tonumber(y) :: number
			if tileX >= left and tileX < left + width and tileY >= top and tileY < top + height then
				w:destroy(fresh.entity)
				pending.at[key] = nil
			end
		end
	end
end

-- Пустые дропы исчезают (sweepDrops).
function drops.sweep(w)
	for _, e in w:each({ "Drop", "Inventory" }) do
		if goods.load(w:get(e, "Inventory")) <= EPSILON then
			w:destroy(e)
		end
	end
end

-- Груз, которого в дропе больше всего (из равных — первый по порядку грузов), и сколько всего: подаче.
function drops.main(w, stock): (string?, number)
	local best, most = nil, 0
	for _, kind in goods.list(w) do
		local amount = goods.amount(stock, kind.name)
		if amount > most then
			best, most = kind.name, amount
		end
	end
	return best, goods.load(stock)
end

return drops
