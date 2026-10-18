--!strict
-- Цеха на панели: свой цех — включить или выключить, в первой ячейке со значком изделия; в сведениях — рецепт, сколько
-- изделия у зоны и что цех делает.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS
local goodWith = panel.goodWith

local function slots(c, list, view)
	local selection = view.selection
	local plant = #selection == 1 and c:mine(selection[1]) and not c:has(selection[1], "Site") and c:get(selection[1], "Assembly")
	if not plant then
		return
	end
	local e = selection[1]
	list[1] = {
		label = if plant.on then c:t("common.turnOff") else c:t("common.turnOn"),
		picture = c.protos.goods[plant.recipe],
		lamp = plant.on,
		title = if plant.on then c:t("grid.plantOffTip") else c:t("grid.plantOnTip"),
		run = function()
			c:send("work", { building = e, on = not plant.on })
		end,
	}
end

local function info(c, view)
	local ui, first, text = c.ui, view.first, view.width
	local assembly = view.built and c:mine(first) and c:get(first, "Assembly")
	local product = assembly and c.protos.goods[assembly.recipe]
	if not (assembly and product) then
		return
	end
	local seconds = 0
	ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
		for _, name in goods.names(c) do
			seconds += product.data.recipe[name] or 0
		end
		-- «{inputs} → {output} за {seconds} с»: на месте подстановок — значки.
		local before, rest = widgets.split(c:t("hud.recipe", { seconds = seconds }), "inputs")
		local middle, after = widgets.split(rest, "output")
		if string.find(before, "%S") then
			ui:text((string.gsub(before, "^%s*(.-)%s*$", "%1")), { color = COLORS.dim })
		end
		for _, name in goods.names(c) do
			local amount = product.data.recipe[name]
			if amount then
				goodWith(c, name, amount, 20)
			end
		end
		ui:text((string.gsub(middle, "^%s*(.-)%s*$", "%1")))
		goodWith(c, product.name, product.data.yield, 20)
		ui:text((string.gsub(after, "^%s*(.-)%s*$", "%1")), { color = COLORS.dim })
	end)
	local zoneStock = 0
	local network = logistics.networkOf(c, first)
	for _, member in (if network then network.members else { first }) do
		local held = c:get(member, "Inventory")
		if held and (logistics.isStore(c, member) or c:has(member, "Assembly")) then
			zoneStock += goods.amount(held, product.name)
		end
	end
	for _, truck in c:each({ "Hauler", "Inventory", "Owner" }) do
		if c:mine(truck) then
			zoneStock += goods.amount(c:get(truck, "Inventory"), product.name)
		end
	end
	local held = c:get(first, "Inventory")
	local full = held and goods.room(held, product.name) < product.data.yield
	local phase = if not assembly.on then (if assembly.progress > 0 then c:t("hud.assemblyStates.offFinishing") else c:t("hud.assemblyStates.off")) elseif assembly.progress > 0 then c:t("hud.assemblyStates.working") elseif full then c:t("hud.assemblyStates.full") else c:t("hud.assemblyStates.waiting")
	widgets.bar(ui, assembly.progress / math.max(seconds, 1e-9), c:t("hud.assembly", { name = c:t(product.data.title), have = math.floor(zoneStock), state = phase }), text)
	if not assembly.on then
		ui:text(c:t("hud.plantOff"), { color = COLORS.warn, wrap = text })
	end
end

return {
	slots = { { at = 100, fill = slots } },
	info = { { at = 190, draw = info } },
}
