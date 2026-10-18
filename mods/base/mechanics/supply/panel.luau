--!strict
-- Снабжение в сведениях: сколько в среднем боеприпасов у своих выбранных юнитов, что в отсеках машин снабжения и на
-- какой радиус они раздают, сколько боеприпасов на складе турели.

local goods = require("lib/goods")
local panel = require("lib/panel")
local supply = require("lib/supply")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS

-- Боеприпасы своих выбранных юнитов с магазинами.
local function army(c, view)
	if not supply.enabled(c) then
		return
	end
	local magazines, filled = 0, 0
	for _, e in view.selection do
		local unit = c:has(e, "Unit") and c:mine(e) and c:proto(e)
		local capacity = if unit then supply.magazineOf(unit) else 0
		if capacity > 0 then
			magazines += 1
			filled += math.min(1, supply.ammoOf(c, e) / capacity)
		end
	end
	if magazines > 0 and filled / magazines < 1 then
		c.ui:text(c:t("hud.armyAmmo", { percent = panel.percent(filled / magazines) }), { color = COLORS.soft, wrap = view.width })
	end
end

-- Машины снабжения: что в отсеках и на какой радиус раздают.
local function bays(c, view)
	local have, capacity, serves = 0, 0, nil
	for _, e in view.selection do
		local unit = c:has(e, "Unit") and c:mine(e) and c:proto(e)
		local stock = unit and unit.data.supplies and c:get(e, "Inventory")
		if stock then
			have += math.floor(goods.amount(stock, "ammo"))
			capacity += stock.capacity
			serves = unit.data.supplies
		end
	end
	if serves then
		local tone = if have <= 0 then COLORS.warn else COLORS.soft
		panel.stockHint(c, c:t("hud.ammo"), "ammo", have, capacity, if have <= 0 then c:t("hud.suppliesEmpty") else c:t("hud.suppliesTip", { radius = serves.radius }), tone, view.width)
	end
end

-- У турели на складе только боеприпасы.
local function turret(c, view)
	local first = view.first
	local stock = not view.many and c:mine(first) and c:get(first, "Inventory")
	local hauler = not view.many and c:get(first, "Hauler")
	if stock and not hauler and view.built and view.kind.data.ammo then
		local have = math.floor(goods.amount(stock, "ammo"))
		local tone = if have <= 0 then COLORS.warn else COLORS.soft
		panel.stockHint(c, c:t("hud.ammo"), "ammo", have, stock.capacity, if have <= 0 then c:t("hud.ammoEmpty") else c:t("hud.ammoTip"), tone, view.width)
	end
end

return {
	info = { { at = 10, draw = army }, { at = 20, draw = bays }, { at = 100, draw = turret } },
}
