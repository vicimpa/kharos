--!strict
-- Ядерный удар на панели: своя готовая ракетная шахта — боеголовка, пуск и отмена; в сведениях — сборка боеголовки и
-- пуск, у перехватчика — сколько ракет, собирает ли следующую и что мешает.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local widgets = require("lib/widgets")
local world = require("lib/world")

local COLORS = widgets.COLORS
local clockOf = widgets.clock
local percent = panel.percent

local function slots(c, list, view)
	local selection = view.selection
	local silo = #selection == 1 and selection[1]
	local state = silo and c:mine(silo) and world.isReady(c, c.player, silo) and c:get(silo, "Silo")
	local warhead = state and c:proto(silo).data.warhead
	if not (state and warhead and view.root) then
		return
	end
	local stage = if state.start >= 0 then "launching" elseif state.ready then "ready" elseif state.ticks > 0 then "assembling" else "empty"
	local lack = c.protos.mechanics.silos.warheadLack(c, c.player, silo)
	local aiming = c.shared.mode ~= nil and c.shared.mode.kind == "aiming" and c.shared.mode.silo == silo
	list[1] = {
		label = c:t("grid.warhead"),
		picture = c.protos.goods.rods,
		cost = if stage == "empty" then warhead.cost else nil,
		materials = if stage == "empty" then warhead.materials else nil,
		c = c,
		stock = (logistics.stockOf(c, c.player)),
		about = c:t("grid.warheadAbout"),
		active = stage ~= "empty",
		disabled = lack ~= nil,
		title = if stage ~= "empty" then c:t("grid.warheadBusy")
			elseif lack == "credits" then c:t("grid.noCredits")
			elseif lack == "materials" then c:t("grid.warheadNoMaterials")
			else c:t("grid.warheadTip", { time = clockOf(warhead.seconds) }),
		run = function()
			c:send("warhead", { silo = silo })
		end,
	}
	list[2] = {
		label = c:t("grid.launch"),
		about = c:t("grid.launchAbout"),
		active = aiming,
		disabled = stage ~= "ready" and stage ~= "launching",
		title = if stage == "launching" then c:t("grid.launchRetarget")
			elseif stage == "ready" then c:t("grid.launchTip", { seconds = warhead.launch })
			else c:t("grid.launchNoWarhead"),
		run = function()
			c.shared.mode = if aiming then nil else { kind = "aiming", silo = silo }
		end,
	}
	if stage == "assembling" then
		list[panel.CANCEL] = { label = c:t("grid.cancel"), title = c:t("grid.cancelWarheadTip"), run = function()
			c:send("cancelWarhead", { silo = silo })
		end }
	elseif stage == "launching" then
		list[panel.CANCEL] = { label = c:t("grid.abortLaunch"), title = c:t("grid.abortLaunchTip"), run = function()
			c:send("abortLaunch", { silo = silo })
		end }
	end
end

-- Ракетная шахта: сборка боеголовки, готова, пуск.
local function silo(c, view)
	local ui, first, kind, text = c.ui, view.first, view.kind, view.width
	local state = view.built and c:mine(first) and kind.data.warhead and c:get(first, "Silo")
	if not state then
		return
	end
	if state.start >= 0 then
		local left = math.max(0, state.start + math.floor(kind.data.warhead.launch / c.step + 0.5) - c.tick)
		ui:text(c:t("hud.launching", { seconds = math.ceil(left * c.step) }), { color = COLORS.warn, wrap = text })
	elseif state.ticks > 0 and not state.ready then
		local progress = math.min(1, state.progress / state.ticks)
		widgets.bar(ui, progress, c:t("hud.warheadAssembling", { percent = percent(progress) }), text)
	else
		ui:text(if state.ready then c:t("hud.warheadReady") else c:t("hud.warheadEmpty"), { color = COLORS.soft, wrap = text })
	end
end

-- Перехватчик: сколько ракет, собирает ли следующую и что мешает.
local function interceptor(c, view)
	local ui, first, text = c.ui, view.first, view.width
	local guard = view.built and c:mine(first) and view.kind.data.intercept
	local charge = guard and c:get(first, "Interceptor")
	if not charge then
		return
	end
	local count, capacity = charge.missiles, guard.capacity
	if charge.ticks > 0 then
		local progress = math.min(1, charge.progress / charge.ticks)
		widgets.bar(ui, progress, c:t("hud.interceptorAssembling", { count = count, capacity = capacity, percent = percent(progress) }), text)
		return
	end
	local lack = c.protos.mechanics.silos.interceptorLack(c, first)
	local list = {}
	for _, name in goods.names(c) do
		local amount = guard.materials[name]
		if amount then
			table.insert(list, amount .. " " .. c:t(c.protos.goods[name].data.title))
		end
	end
	ui:text(if lack == "off" then c:t("hud.interceptorOff", { count = count, capacity = capacity })
		elseif lack == "credits" then c:t("hud.interceptorNoCredits", { count = count, capacity = capacity, cost = guard.cost })
		elseif lack == "materials" then c:t("hud.interceptorNoMaterials", { count = count, capacity = capacity, materials = table.concat(list, ", ") })
		else c:t("hud.interceptorReady", { count = count, capacity = capacity, radius = guard.radius }), { color = COLORS.soft, wrap = text })
end

return {
	slots = { { at = 60, fill = slots } },
	info = { { at = 130, draw = silo }, { at = 140, draw = interceptor } },
}
