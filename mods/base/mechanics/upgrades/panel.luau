--!strict
-- Уровни зданий на панели: свои готовые здания, которые улучшают, — следующий уровень или отмена начатого; в сведениях —
-- уровень и как идёт улучшение.

local construction = require("lib/construction")
local kinds = require("lib/kinds")
local levels = require("lib/levels")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local research = require("lib/research")
local wallet = require("lib/wallet")
local widgets = require("lib/widgets")
local world = require("lib/world")

local COLORS = widgets.COLORS
local number, percent = panel.number, panel.percent

-- Уровень выбранных своих готовых зданий, которые улучшают: level, gain и factor — первого из них; next — заказ
-- следующего уровня всем, кого можно поднять сейчас: цена вместе и чего не хватает; raising — те, что уже поднимают, и
-- как идёт работа у первого из них. nil — таких зданий не выбрано.
local function levelState(c, selection)
	local state = nil
	local materials = {}
	for _, e in selection do
		local kind = kinds.of(c, e)
		local gain = kind and world.isReady(c, c.player, e) and levels.gain(kind)
		if not gain then
			continue
		end
		local level = levels.of(c, e)
		state = state or { level = level, gain = gain, factor = levels.factor(level) }
		local upgrade = c:get(e, "Upgrade")
		if upgrade then
			if not state.raising then
				local ticks = construction.workTicks(levels.cost(kind, level, upgrade.scale).credits, c.step)
				state.raising = { buildings = {}, progress = math.min(1, upgrade.progress / math.max(1, ticks)) }
			end
			table.insert(state.raising.buildings, e)
		elseif levels.upgradable(c, c.player, e) then
			local price = levels.cost(kind, level, levels.scale(c))
			state.next = state.next or { buildings = {}, level = level + 1, factor = levels.factor(level + 1), cost = 0, topic = levels.topic(level) }
			table.insert(state.next.buildings, e)
			state.next.cost += price.credits
			for good, amount in price.materials do
				materials[good] = (materials[good] or 0) + amount
			end
			local lack = levels.lack(c, c.player, e)
			if lack == "research" or (lack == "materials" and not state.next.lack) then
				state.next.lack = lack
			end
		end
	end
	if state and state.next then
		state.next.materials = materials
		if wallet.credits(c, c.player) < state.next.cost and state.next.lack ~= "research" then
			state.next.lack = "credits"
		end
	end
	return state
end

local function slots(c, list, view)
	local raise = view.root and #view.builders == 0 and levelState(c, view.selection)
	local upcoming = raise and raise.next
	if upcoming then
		local topic = research.topic(c, upcoming.topic)
		list[panel.UPGRADE] = {
			label = c:t("grid.upgrade", { level = upcoming.level }),
			picture = c:proto(upcoming.buildings[1]),
			cost = upcoming.cost,
			materials = upcoming.materials,
			c = c,
			stock = (logistics.stockOf(c, c.player)),
			short = upcoming.lack == "credits",
			disabled = upcoming.lack ~= nil,
			title = if upcoming.lack == "research" then c:t("grid.needsResearch", { name = if topic then c:t(topic.data.title) else upcoming.topic })
				elseif upcoming.lack == "credits" then c:t("grid.noCredits")
				elseif upcoming.lack then c:t("grid.upgradeNoMaterials")
				else c:t("grid.upgradeTip", { gain = c:t(levels.GAINS[raise.gain]), factor = number(upcoming.factor) }),
			run = function()
				for _, e in upcoming.buildings do
					c:send("upgrade", { building = e, builders = {} })
				end
			end,
		}
	elseif raise and raise.raising then
		local raising = raise.raising.buildings
		list[panel.UPGRADE] = {
			label = c:t("grid.cancel"),
			title = c:t("grid.cancelUpgradeTip"),
			run = function()
				for _, e in raising do
					c:send("cancelUpgrade", { building = e })
				end
			end,
		}
	end
end

local function info(c, view)
	local raise = view.built and levelState(c, view.selection)
	if not raise then
		return
	end
	local ui, text = c.ui, view.width
	ui:text(if raise.level > 1 then c:t("hud.level", { level = raise.level, max = levels.MAX_LEVEL, gain = c:t(levels.GAINS[raise.gain]), factor = number(raise.factor) }) else c:t("hud.levelBase", { level = raise.level, max = levels.MAX_LEVEL }), { color = COLORS.soft, wrap = text })
	if raise.raising then
		local progress = raise.raising.progress
		widgets.bar(ui, progress, if progress > 0 then c:t("hud.upgrading", { percent = percent(progress) }) else c:t("hud.waitsToUpgrade"), text)
	end
end

return {
	slots = { { at = 80, fill = slots } },
	info = { { at = 120, draw = info } },
}
