--!strict
-- Трубы на панели: у указателя над своей трубой или колодцем — сколько зданий в сети и что в её хранилищах.

local logistics = require("lib/logistics")
local panel = require("lib/panel")
local world = require("lib/world")

local function hover(c, view)
	local tileX, tileY, anchor = panel.hover(c, view)
	if not tileX then
		return
	end
	local e = c:occupant(tileX, tileY)
	local kind = e and c:mine(e) and c:proto(e)
	if not kind or not kind.data.pipe then
		return
	end
	local network = logistics.networkOf(c, e)
	if not network then
		return
	end
	view.tip = true
	local buildings, items, capacity = 0, {}, 0
	for _, member in network.members do
		local other = c:proto(member)
		if other and not other.data.pipe then
			buildings += 1
		end
		if logistics.isStore(c, member) and world.isReady(c, c.player, member) then
			local stock = c:get(member, "Inventory")
			if stock then
				capacity += stock.capacity
				for name, amount in stock.items do
					items[name] = (items[name] or 0) + amount
				end
			end
		end
	end
	local ui = c.ui
	ui:box({ anchor = anchor, skin = "panel", padding = { 8, 12 }, direction = "row", align = "center", gap = 6, passive = true }, function()
		ui:text(c:t("hud.network", { buildings = buildings }))
		panel.goodsRow(c, items, if capacity > 0 then c:t("hud.storesEmpty") else c:t("hud.noStores"))
	end)
end

return {
	overlay = { { at = 61, draw = hover } },
}
