--!strict
-- Лист подробностей ячейки команд: долгое касание (в сценарии — правый щелчок, движок их не различает) открывает
-- карточку с кнопками, крестик закрывает, кнопка действия делает то же, что обычное нажатие. Узкий экран телефона.

return {
	run = function(s)
		s:start("skirmish", { fog = false })
		s:wait(0.5)
		local mcv = s:client("mcv")
		s:click(mcv.x, mcv.y)
		s:check(s:ui_has("MCV"), "MCV не выбран")
		s:ui_click("Развернуть", "right")
		s:check(s:client("mode") == nil, "правый щелчок по ячейке выполнил команду")
		s:check(s:ui_rect("sheet") ~= nil, "лист подробностей не открылся")
		s:ui_click("sheet:close")
		s:check(s:ui_rect("sheet") == nil, "крестик не закрыл лист")
		s:ui_click("Развернуть", "right")
		s:ui_click("sheet:run")
		s:check(s:client("mode") == "deploying", "кнопка листа не начала развёртывание")
		s:check(s:ui_rect("sheet") == nil, "лист не закрылся после действия")
	end,

	client = {
		mode = function(c)
			return c.shared.mode and c.shared.mode.kind
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
