--!strict
-- Энергия на панели: свои готовые потребители — включить или выключить все разом (горит, если хоть один включён); в
-- сведениях — энергия сети станции и накопителя, генератор вне сети с главным зданием, подмога, нехватка, выключено и
-- заряд накопителя.

local economy = require("lib/economy")
local kinds = require("lib/kinds")
local panel = require("lib/panel")
local wallet = require("lib/wallet")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS
local number = panel.number

local function switch(c, list, view)
	local switchable, on = {}, false
	for _, e in view.selection do
		local kind = kinds.of(c, e)
		if c:mine(e) and c:has(e, "Building") and not c:has(e, "Site") and not c:has(e, "Assembly") and kind and economy.switchable(kind) then
			table.insert(switchable, e)
			on = on or not c:has(e, "Off")
		end
	end
	if #switchable > 0 and view.root and not list[panel.SWITCH] then
		list[panel.SWITCH] = {
			label = if on then c:t("common.turnOff") else c:t("common.turnOn"),
			lamp = on,
			title = if on then c:t("grid.switchOffTip") else c:t("grid.switchOnTip"),
			run = function()
				for _, e in switchable do
					c:send("work", { building = e, on = not on })
				end
			end,
		}
	end
end

-- Энергия сети у электростанции и накопителя.
local function grid(c, view)
	local kind = view.kind
	if view.built and ((kind.data.power or 0) > 0 or kind.data.battery) then
		local _, zone = economy.gridOf(c, view.first)
		if zone then
			local state = panel.gridState(zone)
			c.ui:text(panel.gridText(c, state), { color = if state.demand > state.produced or state.overload then COLORS.bad else COLORS.power, wrap = view.width })
		end
	end
end

-- Генератор материи вне сети с главным зданием.
local function coreless(c, view)
	if view.built and economy.coreless(c)[view.first] then
		c.ui:text(c:t("hud.coreless"), { color = COLORS.warn, wrap = view.width })
	end
end

-- Подмога главного здания, пока у игрока мало кредитов.
local function relief(c, view)
	if view.built and c:mine(view.first) and view.kind.name == economy.CORE and wallet.credits(c, c.player) < economy.RELIEF_BELOW then
		c.ui:text(c:t("hud.relief", { below = economy.RELIEF_BELOW, income = economy.RELIEF_INCOME }), { color = COLORS.soft, wrap = view.width })
	end
end

-- Нехватка энергии и выключенное.
local function starved(c, view)
	local hungry, off = false, false
	for _, e in view.selection do
		if c:has(e, "Building") and not c:has(e, "Site") then
			hungry = hungry or economy.states(c)[e] == "starved"
			off = off or (economy.shutDown(c, c.player, e) and not c:has(e, "Assembly"))
		end
	end
	if hungry then
		c.ui:text(c:t("hud.starved"), { color = COLORS.bad, wrap = view.width })
	end
	local switchedOn = false
	for _, e in view.selection do
		if c:mine(e) and c:has(e, "Building") and not c:has(e, "Site") and not c:has(e, "Off") and not c:has(e, "Assembly") and economy.switchable(kinds.of(c, e)) then
			switchedOn = true
		end
	end
	if off and not switchedOn then
		c.ui:text(c:t("hud.switchedOff"), { color = COLORS.warn, wrap = view.width })
	end
end

-- Заряд накопителя и куда идёт энергия.
local function battery(c, view)
	local cell = view.built and c:get(view.first, "Accumulator")
	local spec = cell and view.kind.data.battery
	if not spec then
		return
	end
	local flow = math.round(cell.flow * 100) / 100
	local charge, capacity = math.floor(cell.charge), spec.capacity
	c.ui:text(if flow > 0 then c:t("hud.batteryGiving", { charge = charge, capacity = capacity, flow = number(flow) }) elseif flow < 0 then c:t("hud.batteryCharging", { charge = charge, capacity = capacity, flow = number(-flow) }) else c:t("hud.battery", { charge = charge, capacity = capacity }), { color = COLORS.soft, wrap = view.width })
end

return {
	slots = { { at = 110, fill = switch } },
	info = { { at = 40, draw = grid }, { at = 50, draw = coreless }, { at = 60, draw = relief }, { at = 70, draw = starved }, { at = 200, draw = battery } },
}
