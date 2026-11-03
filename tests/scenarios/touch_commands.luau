--!strict
-- Сенсорные приказы и выделение: касание цели отдаёт приказ и не снимает выбор, удержание с протяжкой рисует рамку,
-- экранные группы сохраняют и возвращают отряд.

return {
	run = function(s)
		s:start("skirmish", { fog = false })
		s:wait(0.5)
		local function tap(id: string)
			local rect = s:ui_rect(id)
			s:check(rect ~= nil, "в интерфейсе нет " .. id)
			local x, y = rect.x + rect.w / 2, rect.y + rect.h / 2
			s:touch(x, y, true)
			s:touch(x, y, false)
			s:frames(1)
		end
		local mcv = s:client("mcv")
		s:touch(mcv.x, mcv.y, true)
		s:touch(mcv.x, mcv.y, false)
		s:check(s:client("selected") == 1, "касание не выделило MCV")
		s:touch(mcv.x + 160, mcv.y + 80, true)
		s:touch(mcv.x + 160, mcv.y + 80, false)
		s:wait(0.2)
		s:check(s:client("selected") == 1, "касание приказа сняло выделение")
		s:check(s:host("moving", mcv.entity), "касание цели не отдало приказ")
		local box = s:client("box")
		s:touch(box.left, box.top, true)
		s:wait(0.6)
		s:touch(box.right, box.bottom)
		s:touch(box.right, box.bottom, false)
		s:wait(0.2)
		s:check(s:client("selected") >= 5, "долгое касание с протяжкой не выделило отряд рамкой")
		tap("touch:groups")
		tap("group:1")
		tap("touch:clear")
		s:check(s:client("selected") == 0, "кнопка не сняла выделение")
		tap("group:1")
		s:check(s:client("selected") >= 5, "экранная группа не вернула отряд")
	end,

	client = {
		selected = function(c)
			return #(c.shared.selection or {})
		end,
		mcv = function(c)
			for _, e in c:each({ "Unit" }) do
				local kind = c:proto(e)
				if c:mine(e) and kind and kind.name == "mcv" then
					local at = c:get(e, "Position")
					local x, y = c:to_screen(at.x, at.y)
					return { entity = e, x = x, y = y }
				end
			end
			return nil
		end,
		box = function(c)
			local left, top, right, bottom = math.huge, math.huge, -math.huge, -math.huge
			for _, e in c:each({ "Unit", "Position" }) do
				if c:mine(e) then
					local at = c:get(e, "Position")
					local x, y = c:to_screen(at.x, at.y)
					left, top = math.min(left, x - 24), math.min(top, y - 24)
					right, bottom = math.max(right, x + 24), math.max(bottom, y + 24)
				end
			end
			return { left = left, top = top, right = right, bottom = bottom }
		end,
	},

	host = {
		moving = function(ctx, entity: number)
			local path = ctx:get(entity, "Path")
			return path ~= nil and #path.points >= 2
		end,
	},
}
