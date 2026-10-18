--!strict
-- Звуки интерфейса: щелчок по кнопке, касание кнопки при наведении, отказ у недоступной, выделение юнитов и зданий.
-- Приказы звучат там, где их отдают (controls/orders).

local VOLUME = 0.35
local HOVER_VOLUME = 0.12
-- Чаще этого выделение не звучит: протянутая рамка меняет его каждый кадр.
local SELECT_GAP = 0.12

local selected = ""
local clock = 0
local selectedAt = -math.huge

return {
	update = function(c)
		if not c.audio then
			return
		end
		clock += c.dt
		local pressed = c.ui.pressed
		if pressed then
			c:sound(pressed, { volume = VOLUME, detune = 0.08 })
		elseif c.ui.hovered_button then
			c:sound("hover", { volume = HOVER_VOLUME })
		end
		-- Выделение сменилось и в нём что-то есть — щелчок: у юнитов один, у здания другой. Снятое молчит.
		local selection = c.shared.selection or {}
		local parts = {}
		for _, e in selection do
			table.insert(parts, tostring(e))
		end
		local key = table.concat(parts, ",")
		if key == selected then
			return
		end
		selected = key
		if #selection == 0 or clock - selectedAt < SELECT_GAP then
			return
		end
		selectedAt = clock
		local units = false
		for _, e in selection do
			if c:has(e, "Unit") then
				units = true
			end
		end
		c:sound(if units then "select" else "selectBuilding", { volume = VOLUME })
	end,
}
