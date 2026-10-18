--!strict
-- Сдача на панели: выбранных своих юнитов можно уничтожить — сначала кнопка, потом подтверждение на своей странице и на
-- другой клавише.

local defeat = require("lib/defeat")
local panel = require("lib/panel")

-- Выделение, для которого открыто подтверждение; сменилось — страница закрыта.
local scuttling = { key = "" }

-- Подтверждение забирает сетку целиком.
local function confirm(c, _list, view)
	local key = table.concat(view.selection, ",")
	if scuttling.key ~= key then
		scuttling.key = ""
		return
	end
	local gift = defeat.giftable(c, c.player, view.selection)
	if #gift == 0 then
		scuttling.key = ""
		return
	end
	local page = {}
	page[1] = {
		label = c:t("grid.scuttleConfirm", { count = #gift }),
		title = c:t("grid.scuttleConfirmTip"),
		run = function()
			c:send("scuttle", { units = gift })
			scuttling.key = ""
		end,
	}
	page[panel.BACK] = {
		label = c:t("common.back"),
		run = function()
			scuttling.key = ""
		end,
	}
	view.exclusive = page
end

-- Кнопка на месте отмены: оно занято, только пока разворачивается MCV.
local function button(c, list, view)
	if view.root and not list[panel.CANCEL] and #defeat.giftable(c, c.player, view.selection) > 0 then
		list[panel.CANCEL] = {
			label = c:t("grid.scuttle"),
			title = c:t("grid.scuttleTip"),
			run = function()
				scuttling.key = table.concat(view.selection, ",")
			end,
		}
	end
end

return {
	slots = { { at = 0, fill = confirm }, { at = 120, fill = button } },
}
