--!strict
-- Реактор в сведениях: сколько стержней и горит ли стержень.

local economy = require("lib/economy")
local goods = require("lib/goods")
local panel = require("lib/panel")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS

local function info(c, view)
	local first = view.first
	local stock = not view.many and c:mine(first) and c:get(first, "Inventory")
	local burns = view.built and view.kind.data.burns
	if not (stock and burns) then
		return
	end
	local have = math.floor(goods.amount(stock, burns.good))
	local burning = economy.burning(c, first)
	local tone = if have <= 0 and not burning then COLORS.warn else COLORS.soft
	panel.stockHint(c, c:t("hud.rods"), burns.good, have, stock.capacity, if burning then c:t("hud.rodsTip") else c:t("hud.rodsEmpty"), tone, view.width)
end

return {
	info = { { at = 110, draw = info } },
}
