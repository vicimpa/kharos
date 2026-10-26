--!strict
-- Камера пальцем: протяжка по карте двигает камеру за пальцем и ничего не выделяет, отпущенная на ходу — катится
-- дальше; касание на месте по-прежнему выделяет. Узкий экран телефона.

return {
	run = function(s)
		s:start("skirmish", { fog = false })
		s:wait(0.5)
		local mcv = s:client("mcv")
		-- Протяжка из пустого места над MCV вниз: камера уходит вверх, MCV на экране — вниз вместе с пальцем.
		local x, y = mcv.x, mcv.y - 120
		local before = s:client("camera")
		s:touch(x, y, true)
		for step = 1, 10 do
			s:touch(x, y + step * 20)
		end
		local held = s:client("camera")
		s:check(math.abs((before.y - held.y) * before.zoom - 200) < 1, "камера не идёт за пальцем")
		s:check(math.abs(before.x - held.x) < 1e-6, "камера сдвинулась вбок")
		s:touch(x, y + 200, false)
		s:wait(0.5)
		local after = s:client("camera")
		s:check(after.y < held.y, "брошенная камера не катится дальше")
		s:check(s:client("selected") == 0, "протяжка пальцем выделила")
		-- Касание на месте — выбор.
		mcv = s:client("mcv")
		s:touch(mcv.x, mcv.y, true)
		s:touch(mcv.x, mcv.y, false)
		s:wait(0.1)
		s:check(s:client("selected") == 1, "касание не выделило MCV")
		s:check(s:ui_has("MCV"), "MCV не выбран")
	end,

	client = {
		camera = function(c)
			return { x = c.camera.x, y = c.camera.y, zoom = c.camera.zoom }
		end,
		selected = function(c)
			return #(c.shared.selection or {})
		end,
		mcv = function(c)
			for _, e in c:each({ "Unit" }) do
				local kind = c:proto(e)
				if c:mine(e) and kind and kind.name == "mcv" then
					local at = c:get(e, "Position")
					local x, y = c:to_screen(at.x, at.y)
					return { x = x, y = y }
				end
			end
			return nil
		end,
	},
}
