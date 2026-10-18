--!strict
-- Превращения на панели: MCV разворачивают как строят — кнопка включает выбор места, он доедет туда сам; главное здание
-- сворачивается обратно; в сведениях — как идёт превращение и что сделать с MCV.

local conversion = require("lib/conversion")
local panel = require("lib/panel")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS

-- Превращение выбранного: MCV разворачивается, главное здание сворачивается; nil — не то.
local function conversionOf(c, e: number)
	local kind = c:proto(e)
	local unit = c:has(e, "Unit")
	if not kind or kind.id ~= (if unit then conversion.unit(c) else conversion.building(c)).id then
		return nil
	end
	local converting = c:get(e, "Converting")
	local mode = c.shared.mode
	return {
		unit = unit,
		possible = if unit then conversion.canSend(c, c.player, e) else conversion.canPack(c, c.player, e),
		progress = if converting then 1 - converting.left / converting.total else nil,
		blocked = conversion.blocked(c, e),
		choosing = mode ~= nil and mode.kind == "deploying" and mode.unit == e,
		traveling = not converting and c:has(e, "Deploys"),
		cancel = unit and (converting ~= nil or c:has(e, "Deploys")),
	}
end

-- Развернуть или свернуть; отменить разворачивание или поездку на него.
local function slots(c, list, view)
	local selection = view.selection
	local state = #selection == 1 and c:mine(selection[1]) and conversionOf(c, selection[1])
	if not state then
		return
	end
	local e = selection[1]
	if not state.progress then
		local building = conversion.building(c)
		list[panel.CONVERT] = {
			label = if state.unit then c:t("grid.deploy") else c:t("grid.pack"),
			picture = building,
			about = if state.unit then c:t(building.data.info) else nil,
			title = if state.unit then c:t("grid.deployTip") else nil,
			disabled = not state.possible,
			active = state.choosing,
			hint = state.unit and not state.traveling and (panel.currentStep(c) or {}).deploy == true,
			run = function()
				if not state.unit then
					c:send("pack", { building = e })
				elseif state.choosing then
					c.shared.mode = nil
				else
					c.shared.mode = { kind = "deploying", unit = e }
				end
			end,
		}
	end
	if (state.progress or state.traveling) and state.cancel then
		list[panel.CANCEL] = {
			label = c:t("grid.cancel"),
			run = function()
				c:send("cancelDeploy", { unit = e })
			end,
		}
	end
end

local function stateOf(c, view)
	return not view.many and c:mine(view.first) and conversionOf(c, view.first)
end

-- Как идёт превращение.
local function progress(c, view)
	local state = stateOf(c, view)
	if state and state.progress then
		widgets.bar(c.ui, state.progress, if state.blocked then c:t("hud.blocked") elseif state.unit then c:t("hud.deploying") else c:t("hud.packing"), view.width)
	end
end

-- Что сделать с MCV.
local function tip(c, view)
	local state = stateOf(c, view)
	if state and state.unit and not state.progress and not state.choosing then
		c.ui:text(if state.traveling then c:t("hud.deployTravel") else c:t("hud.mcvTip"), { color = COLORS.soft, wrap = view.width })
	end
end

return {
	slots = { { at = 20, fill = slots } },
	info = { { at = 210, draw = progress }, { at = 240, draw = tip } },
}
