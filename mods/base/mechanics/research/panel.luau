--!strict
-- Лаборатория в сведениях: что ведут и почему стоит.

local panel = require("lib/panel")
local research = require("lib/research")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS

local function info(c, view)
	local ui, text = c.ui, view.width
	local lab = view.built and c:mine(view.first) and c:get(view.first, "Research")
	if not lab then
		return
	end
	local topic = research.current(c, c.player)
	local state = research.player(c, c.player)
	if not topic then
		ui:text(c:t("hud.researchIdle"), { color = COLORS.soft, wrap = text })
		return
	end
	local progress = (state and state.progress or {})[topic] or 0
	widgets.bar(ui, progress, c:t("hud.researching", { name = c:t(research.topic(c, topic).data.title), percent = panel.percent(progress) }), text)
	if lab.lack ~= "off" then
		local goodKind = c.protos.goods[lab.lack]
		local message = if lab.lack == "power" then c:t("hud.labNoPower")
			elseif lab.lack == "credits" then c:t("hud.labNoCredits")
			elseif goodKind then c:t("hud.labLacks", { name = c:t(goodKind.data.title) })
			else c:t("hud.labSpeed", { speed = lab.speed })
		ui:text(message, { color = if lab.lack ~= "" and lab.lack ~= "idle" then COLORS.warn else COLORS.soft, wrap = text })
	end
end

return {
	info = { { at = 170, draw = info } },
}
