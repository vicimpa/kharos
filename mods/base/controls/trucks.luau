--!strict
-- Приказы грузовикам мышью. Кнопки сетки включают режим c.shared.mode:
--   routing — левый щелчок по своему зданию со складом — ещё остановка; правая кнопка или Enter — маршрут готов;
--   serving — левый щелчок отмечает здание или снимает отметку; правая кнопка или Enter — готово;
--   carrySource — щелчок по складу, откуда взять: откроется окно приказа (c.shared.truckMenu);
--   carryTarget — щелчок по получателю: грузовики везут выбранное; правый щелчок мимо — отмена.
-- Esc — отмена. Выбраны одни грузовики — правый щелчок по своему зданию со складом открывает окно приказа: что взять,
-- выгрузить, возить, обеспечить. Грузовиков среди выбранных не осталось — режим и окно закрываются сами.

local construction = require("lib/construction")
local drops = require("lib/drops")
local goods = require("lib/goods")
local world = require("lib/world")

local trucks = {}

trucks.data = {
	-- Сдвиг указателя, после которого щелчок становится рамкой, в пикселях.
	threshold = 6,
}

local MODES = { routing = true, serving = true, carrySource = true, carryTarget = true }

local pressed: { x: number, y: number }? = nil
local rightPress: { x: number, y: number }? = nil

-- Свои выбранные грузовики.
function trucks.selected(c): { number }
	local list = {}
	for _, e in c.shared.selection or {} do
		if c:alive(e) and c:mine(e) and c:has(e, "Hauler") and c:has(e, "Unit") then
			table.insert(list, e)
		end
	end
	return list
end

-- Склад на тайле: здание, стройка или дроп.
function trucks.storeAt(c, x: number, y: number): number?
	local tx, ty = math.floor(x), math.floor(y)
	local found = c:occupant(tx, ty) or construction.siteAt(c, tx, ty) or drops.at(c, tx, ty)
	if found and c:has(found, "Inventory") then
		return found
	end
	return nil
end

-- Годится ли склад отдать по приказу: своё здание или стройка со складом, или дроп.
function trucks.isCarrySource(c, e: number?): boolean
	if not e or not c:alive(e) or not c:has(e, "Inventory") then
		return false
	end
	return drops.is(c, e) or (c:mine(e) and not c:has(e, "Unit"))
end

-- Годится ли склад принять груз по приказу: своё здание или стройка со складом, где груз поместится; стройке — только
-- её материалы.
function trucks.isCarryTarget(c, e: number?, good: string): boolean
	if not e or not c:alive(e) or not c:mine(e) or c:has(e, "Hauler") then
		return false
	end
	local stock = c:get(e, "Inventory")
	if not stock or (c:has(e, "Site") and not table.find(stock.accepts, good)) then
		return false
	end
	return goods.room(stock, good) > goods.EPSILON
end

-- Годится ли здание в остановку маршрута или обслуживание: своё готовое со складом.
function trucks.isStop(c, e: number?): boolean
	return e ~= nil and world.isReady(c, c.player, e) and c:has(e, "Inventory")
end

-- Отдаёт набранный маршрут или список обслуживания выбранным грузовикам: меньше двух остановок или ничего не отмечено —
-- набор просто кончается.
function trucks.finish(c)
	local mode = c.shared.mode
	c.shared.mode = nil
	c.shared.modeClosedAt = c.time
	if not mode then
		return
	end
	local units = trucks.selected(c)
	if mode.kind == "routing" and #mode.stops > 1 then
		c:send("route", { units = units, stops = mode.stops })
		c:sound("order", { volume = 0.35 })
	elseif mode.kind == "serving" and #mode.buildings > 0 then
		c:send("serve", { units = units, buildings = mode.buildings })
		c:sound("order", { volume = 0.35 })
	end
end

-- Щелчок в режиме: что он значит.
local function click(c, mode, wx: number, wy: number, right: boolean)
	local shared = c.shared
	if mode.kind == "routing" or mode.kind == "serving" then
		if right then
			trucks.finish(c)
			return
		end
		local building = c:occupant(math.floor(wx), math.floor(wy))
		if not building or not trucks.isStop(c, building) then
			return
		end
		if mode.kind == "routing" then
			if mode.stops[#mode.stops] ~= building then
				table.insert(mode.stops, building)
			end
		else
			local at = table.find(mode.buildings, building)
			if at then
				table.remove(mode.buildings, at)
			else
				table.insert(mode.buildings, building)
			end
		end
		return
	end
	local target = trucks.storeAt(c, wx, wy)
	local fits = if mode.kind == "carrySource" then trucks.isCarrySource(c, target) else target ~= mode.from and trucks.isCarryTarget(c, target, mode.resource)
	if fits then
		if mode.kind == "carrySource" then
			shared.truckMenu = target
		else
			c:send("carry", { units = trucks.selected(c), from = mode.from, to = target, resource = mode.resource, amount = mode.amount })
			c:sound("order", { volume = 0.35 })
		end
		shared.mode = nil
		shared.modeClosedAt = c.time
	elseif right then
		shared.mode = nil
		shared.modeClosedAt = c.time
	else
		c:sound("deny", { volume = 0.5 })
	end
end

function trucks.update(c)
	local shared, input = c.shared, c.input
	if shared.paused then
		pressed = nil
		return
	end
	local selected = trucks.selected(c)
	-- Окно приказа: грузовиков не осталось или здание пропало — закрыто.
	if shared.truckMenu and (#selected == 0 or not c:alive(shared.truckMenu)) then
		shared.truckMenu = nil
	end
	local mode = shared.mode
	if not mode or not MODES[mode.kind] then
		pressed = nil
		-- Одни грузовики выбраны, правый щелчок по своему складу — окно приказа (а не приказ точкой); щелчок — на
		-- отпускании без протяжки: протяжка правой двигает камеру.
		if not mode and input.pressed.right and input.inside and not input.over_ui then
			rightPress = { x = input.x, y = input.y }
		end
		local press = rightPress
		if press and input.released.right then
			rightPress = nil
			local still = math.abs(input.x - press.x) <= 4 and math.abs(input.y - press.y) <= 4
			if still and not mode and not input.keys.shift and #selected > 0 and #selected == #(shared.selection or {}) then
				local target = trucks.storeAt(c, input.wx, input.wy)
				if trucks.isCarrySource(c, target) then
					shared.truckMenu = target
				end
			end
		end
		return
	end
	if #selected == 0 or (mode.kind == "carryTarget" and not c:alive(mode.from) and mode.from ~= -1) then
		shared.mode = nil
		return
	end
	if input.hits.escape then
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	if input.hits.enter and (mode.kind == "routing" or mode.kind == "serving") then
		trucks.finish(c)
		return
	end
	if input.pressed.right and input.inside and not input.over_ui then
		click(c, mode, input.wx, input.wy, true)
		return
	end
	if input.pressed.left and input.inside and not input.over_ui then
		pressed = { x = input.x, y = input.y }
	end
	local start = pressed
	if start and input.released.left then
		pressed = nil
		if math.abs(input.x - start.x) + math.abs(input.y - start.y) > trucks.data.threshold then
			return
		end
		click(c, mode, input.wx, input.wy, false)
		-- Щелчок — действие режима, а не выделение.
		shared.swallow = true
	end
end

return trucks
