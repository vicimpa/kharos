--!strict
-- Выбор места для MCV (scene.deploying в controls.ts): кнопка «Развернуть» включает режим c.shared.mode, под
-- указателем — призрак главного здания серединой в тайле, зелёный там, где MCV сможет развернуться (placementOf).
-- Щелчок — MCV едет туда и разворачивается, режим кончается; на негодном месте — отказ. Правая кнопка и Esc —
-- отмена; сняли MCV с выбора или он уже разворачивается — режим кончается сам.

local conversion = require("lib/conversion")
local placement = require("lib/placement")

local deploy = {}

deploy.data = {
	-- Сдвиг указателя, после которого щелчок уже не щелчок, в пикселях.
	threshold = 6,
}

-- Призрак места: годится и нет (GHOST, GHOST_FORBIDDEN), с предумноженной альфой.
local GHOST = { 0.7, 0.7, 0.7, 0.7 }
local FORBIDDEN = { 0.7, 0.14, 0.1, 0.7 }

local pressed: { x: number, y: number }? = nil

-- Место под указателем: левый верхний тайл главного здания серединой под ним и годится ли оно.
local function placementOf(c, unit: number): (number, number, boolean)
	local data = conversion.building(c).data
	local x = math.floor(c.input.wx) - math.floor(data.width / 2)
	local y = math.floor(c.input.wy) - math.floor(data.height / 2)
	return x, y, conversion.canDeployAt(c, c.player, unit, x, y)
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
	-- Esc сначала снимает режим, и только следующим нажатием — выделение.
	if input.hits.escape then
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	if input.pressed.right and input.inside and not input.over_ui then
		shared.mode = nil
		return
	end
	local x, y, allowed = placementOf(c, unit)
	if input.inside then
		local building = conversion.building(c)
		c:show(building, placement.middle(x, building.data.width), placement.middle(y, building.data.height), { tint = if allowed then GHOST else FORBIDDEN, over = true })
	end
	if input.pressed.left and input.inside and not input.over_ui then
		pressed = { x = input.x, y = input.y }
	end
	if pressed and input.released.left then
		local dragged = math.abs(input.x - pressed.x) + math.abs(input.y - pressed.y) > deploy.data.threshold
		pressed = nil
		if dragged then
			return
		end
		if allowed then
			c:send("deploy", { unit = unit, x = x, y = y })
			shared.mode = nil
		else
			c:sound("deny", { volume = 0.35 })
		end
	end
end

return deploy
