--!strict
-- Списки пальцем: касание открывает настройки, протяжка по окну прокручивает его за пальцем, а кнопка, на которой
-- палец начал протяжку, не нажимается. Телефон лёжа — настройки не влезают по высоте.

return {
	run = function(s)
		s:wait(0.5)
		local button = s:ui_find("Настройки")
		s:check(button ~= nil, "нет кнопки настроек в меню")
		s:touch(button.x + button.w / 2, button.y + button.h / 2, true)
		s:touch(button.x + button.w / 2, button.y + button.h / 2, false)
		s:wait(0.1)
		local body = s:ui_rect("settings:body")
		s:check(body ~= nil, "касание не открыло настройки")
		-- Начать на кнопке языка и вести вверх.
		local start = s:ui_find("English")
		local x, y = start.x + start.w / 2, start.y + start.h / 2
		s:touch(x, y, true)
		for step = 1, 8 do
			s:touch(x, y - step * 10)
		end
		s:touch(x, y - 80, false)
		s:wait(0.1)
		local moved = s:ui_find("English")
		s:check(math.abs(start.y - moved.y - 80) < 1, "окно не прокрутилось за пальцем")
		s:check(s:ui_has("Настройки"), "протяжка нажала кнопку под пальцем")
	end,
}
