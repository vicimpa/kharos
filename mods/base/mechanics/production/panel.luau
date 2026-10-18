--!strict
-- Производство на панели: свои производители — одно или несколько зданий одного вида — заказ получает наименее занятый,
-- очередь видна и отменяется у самого занятого; в сведениях — что строится, очередь, лимит армии и точка сбора.

local construction = require("lib/construction")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local research = require("lib/research")
local wallet = require("lib/wallet")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS

local function slots(c, list, view)
	local producers = {}
	for _, e in view.selection do
		if c:has(e, "Producer") and c:mine(e) and not c:has(e, "Site") then
			table.insert(producers, e)
		end
	end
	local sameKind = #producers > 0
	for _, e in producers do
		sameKind = sameKind and (#producers == 1 or (c:has(e, "Building") and c:proto(e) == c:proto(producers[1])))
	end
	if not sameKind then
		return
	end
	local function ordersOf(e: number): number
		local producer = c:get(e, "Producer")
		return #producer.queue + (if producer.unit ~= "" then 1 else 0)
	end
	local building, busiest = producers[1], producers[1]
	for _, e in producers do
		if ordersOf(e) < ordersOf(building) then
			building = e
		end
		if ordersOf(e) > ordersOf(busiest) then
			busiest = e
		end
	end
	local kind = c:proto(building)
	local money = wallet.credits(c, c.player)
	local orders = ordersOf(busiest)
	local production = c.protos.mechanics.production
	-- Очередь полна — заказывать некуда.
	local full = ordersOf(building) >= production.data.queue
	local limit = production.limit(c)
	local army = if limit > 0 then production.army(c, c.player) else 0
	local techTree = construction.rules(c).techTree
	for _, name in kind.data.produces or {} do
		local unit = c.protos.units[name]
		if unit then
			local missing = if techTree then construction.missing(c, c.player, unit.data.requires) else {}
			local topic = if construction.researched(c, c.player, unit.data.research) then nil else research.topic(c, unit.data.research)
			local titles = {}
			for _, needed in missing do
				local other = c.protos.buildings[needed]
				table.insert(titles, if other then c:t(other.data.title) else needed)
			end
			local affordable = money >= unit.data.cost
			local capped = limit > 0 and army + (unit.data.supply or 0) > limit
			table.insert(list, {
				label = c:t(unit.data.title) or name,
				picture = unit,
				cost = unit.data.cost,
				materials = unit.data.materials,
				c = c,
				stock = (logistics.stockOf(c, c.player)),
				short = not affordable,
				unit = unit,
				disabled = not affordable or full or #missing > 0 or topic ~= nil or capped,
				title = if #missing > 0 then c:t("grid.needs", { list = table.concat(titles, ", ") })
					elseif topic then c:t("grid.needsResearch", { name = c:t(topic.data.title) })
					elseif full then c:t("grid.queueFull")
					elseif capped then c:t("grid.armyLimit", { used = army, limit = limit, supply = unit.data.supply or 0 })
					elseif not affordable then c:t("grid.noCredits")
					else nil,
				hint = (panel.currentStep(c) or {}).unit == name,
				run = function()
					c:send("produce", { building = building, unit = name })
				end,
			})
		end
	end
	if orders > 0 and not list[panel.CANCEL] then
		list[panel.CANCEL] = {
			label = c:t("grid.cancelOrder"),
			title = c:t("grid.cancelOrderTip"),
			run = function()
				c:send("cancel", { building = busiest })
			end,
		}
	end
end

-- Что строится и очередь; армия: сколько места в лимите занято; точка сбора.
local function info(c, view)
	local ui, first, text = c.ui, view.first, view.width
	local producer = not view.many and c:get(first, "Producer")
	if not producer then
		return
	end
	local packed = c:has(first, "Unit")
	if producer.unit ~= "" then
		local unit = c.protos.units[producer.unit]
		widgets.bar(ui, producer.progress / (unit.data.buildTime or 1), c:t(unit.data.title) or producer.unit, text)
		ui:box({ direction = "row", gap = 4 }, function()
			for i, name in { producer.unit, table.unpack(producer.queue) } do
				ui:box({ id = "queue:" .. i, width = 32, height = 32, skin = "well", padding = 4 }, function()
					ui:image(c.protos.units[name], panel.QUEUED, panel.QUEUED)
				end)
			end
		end)
	end
	if packed and producer.unit ~= "" then
		ui:text(c:t("hud.packedQueue"), { color = COLORS.soft, wrap = text })
	end
	local production = c.protos.mechanics.production
	local limit = production.limit(c)
	if limit > 0 then
		ui:text(c:t("hud.army", { used = production.army(c, c.player), limit = limit }), { color = COLORS.soft, wrap = text })
	end
	if not packed then
		ui:text(if producer.rally then c:t("hud.rallySet") else c:t("hud.rallyTip"), { color = COLORS.soft, wrap = text })
	end
end

return {
	slots = { { at = 50, fill = slots } },
	info = { { at = 220, draw = info } },
}
