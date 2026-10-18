--!strict
-- Месторождение в сведениях шахты: какая руда под ней и сколько осталось.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local widgets = require("lib/widgets")

local function info(c, view)
	if not (view.built and view.kind.data.extract) then
		return
	end
	local ui = c.ui
	local deposit = logistics.depositUnder(c, view.first)
	local depositKind = deposit and c:proto(deposit)
	local ore = depositKind and c.protos.goods[goods.oreOf(c, depositKind.name) or ""]
	if deposit and ore then
		local left = c:get(deposit, "Deposit").reserve
		ui:box({ direction = "row", align = "center", gap = 6, width = view.width }, function()
			panel.goodWith(c, ore.name, nil, 20)
			local line = c:t("hud.depositLeft", { name = c:t(ore.data.title), left = if left > 0 then c:t("hud.left", { amount = math.floor(left) }) else c:t("hud.depositDepleted") })
			local _, after = widgets.split(line, "icon")
			ui:text((string.gsub(after, "^%s+", "")), { color = widgets.COLORS.soft })
		end)
	end
end

return {
	info = { { at = 160, draw = info } },
}
