--!strict
-- Телефон стоя: мини-карта свёрнута, выбранное и команды не отнимают у карты лишние ряды.

return {
	run = function(s)
		s:start("skirmish", { fog = false })
		s:wait(0.5)
		if not s:client("portrait") then
			return
		end
		local mcv = s:client("mcv")
		s:touch(mcv.x, mcv.y, true)
		s:touch(mcv.x, mcv.y, false)
		s:wait(0.2)
		local function tap(id: string)
			local rect = s:ui_rect(id)
			s:check(rect ~= nil, "в интерфейсе нет " .. id)
			s:touch(rect.x + rect.w / 2, rect.y + rect.h / 2, true)
			s:touch(rect.x + rect.w / 2, rect.y + rect.h / 2, false)
			s:frames(1)
		end
		s:check(s:ui_rect("mm:toggle") ~= nil, "нет кнопки свёрнутой мини-карты")
		s:check(s:ui_rect("minimap") == nil, "мини-карта развёрнута без запроса")
		local selected = s:ui_rect("sel")
		s:check(selected ~= nil and selected.h <= 112, "сведения выбранного слишком высоки")
		local commands = s:ui_rect("act")
		s:check(commands ~= nil and commands.h <= 140, "команды заняли лишние ряды")
		s:check(s:ui_has("Зоны"), "кнопка зон не переведена")
		tap("mm:toggle")
		s:check(s:ui_rect("minimap") ~= nil, "мини-карта не открылась")
		tap("mm:toggle")
		s:check(s:ui_rect("minimap") == nil, "мини-карта не свернулась")
	end,

	client = {
		portrait = function(c)
			return c.screen.h > c.screen.w
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
