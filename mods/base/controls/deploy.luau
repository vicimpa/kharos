--!strict
-- Выбор места для MCV: кнопка «Развернуть» включает режим c.shared.mode, под указателем — призрак главного здания
-- серединой в тайле, зелёный там, где MCV сможет развернуться. Щелчок — MCV едет туда и разворачивается, режим
-- кончается; на негодном месте — отказ. Правая кнопка и Esc — отмена; сняли MCV с выбора или он уже разворачивается —
-- режим кончается сам. На сенсорном призрак стоит в центре, карта движется пальцем, подтверждение — «Поставить».

local conversion = require("lib/conversion")
local placement = require("lib/placement")

local deploy = {}

deploy.data = {
	-- Сдвиг указателя, после которого щелчок уже не щелчок, в пикселях.
	threshold = 6,
}

-- Призрак места: годится и нет, с предумноженной альфой.
local GHOST = { 0.7, 0.7, 0.7, 0.7 }
local FORBIDDEN = { 0.7, 0.14, 0.1, 0.7 }

local pressed: { x: number, y: number }? = nil

-- Место под указателем: левый верхний тайл главного здания серединой под ним и годится ли оно.
local function placementOf(c, unit: number, wx: number?, wy: number?): (number, number, boolean)
	local data = conversion.building(c).data
	local x = math.floor(wx or c.input.wx) - math.floor(data.width / 2)
	local y = math.floor(wy or c.input.wy) - math.floor(data.height / 2)
	return x, y, conversion.canDeployAt(c, c.player, unit, x, y)
end

function deploy.confirm(c)
	local shared, input = c.shared, c.input
	local mode = shared.mode
	if not mode or mode.kind ~= "deploying" then
		return
	end
	local unit = mode.unit
	if not table.find(shared.selection or {}, unit) or not c:alive(unit) or not conversion.canSend(c, c.player, unit) then
		return
	end
	local wx, wy = input.wx, input.wy
	if input.touch then
		wx, wy = c:to_world(c.screen.w / 2, c.screen.h / 2)
	end
	local x, y, allowed = placementOf(c, unit, wx, wy)
	if allowed then
		c:send("deploy", { unit = unit, x = x, y = y })
		shared.mode = nil
	else
		c:sound("deny", { volume = 0.35 })
	end
end

function deploy.update(c)
	local shared, input = c.shared, c.input
	local mode = shared.mode
	if not mode or mode.kind ~= "deploying" then
		pressed = nil
		return
	end
	local unit = mode.unit
	if not table.find(shared.selection or {}, unit) or not c:alive(unit) or not conversion.canSend(c, c.player, unit) then
		shared.mode = nil
		return
	end
	if shared.paused then
		pressed = nil
		return
	end
	if input.multitouch or input.touch then
		pressed = nil
	end
	-- Esc сначала снимает режим, и только следующим нажатием — выделение.
	if input.hits.escape then
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	if input.pressed.right and input.inside and not input.over_ui then
		-- Тот же щелчок приказом уже не станет (controls/orders).
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	local wx, wy = input.wx, input.wy
	if input.touch then
		wx, wy = c:to_world(c.screen.w / 2, c.screen.h / 2)
	end
	local x, y, allowed = placementOf(c, unit, wx, wy)
	if input.touch or input.inside then
		local building = conversion.building(c)
		c:show(building, placement.middle(x, building.data.width), placement.middle(y, building.data.height), { tint = if allowed then GHOST else FORBIDDEN, over = true })
	end
	if not input.touch and input.pressed.left and input.inside and not input.over_ui then
		pressed = { x = input.x, y = input.y }
	end
	if pressed and input.released.left then
		local dragged = math.abs(input.x - pressed.x) + math.abs(input.y - pressed.y) > deploy.data.threshold
		pressed = nil
		if not dragged then
			deploy.confirm(c)
		end
	end
end

-- Полоса режима (ui/hud): название и что делать.
deploy.modes = {
	deploying = {
		describe = function(c)
			return c:t("mode.deploying"), c:t(if c.input.touch then "mode.tips.deployingTouch" else "mode.tips.deploying")
		end,
		touchDone = deploy.confirm,
		doneLabel = "mode.place",
	},
}

return deploy
