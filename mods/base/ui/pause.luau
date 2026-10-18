--!strict
-- Меню поверх партии — перенос pauseMenu из packages/client/src/gui/screens/play.ts: продолжить и выйти в главное
-- меню. Открывается кнопкой «Меню» на верхней полосе и Escape, когда отменять нечего (controls/select); игра за ним
-- идёт дальше, управление молчит (c.shared.paused), Escape закрывает. Настройки, «Сдаться» и «Сохранить и выйти»
-- придут с настройками, поражением и сохранениями (docs/port.md, А3, А4, В9).

local form = require("lib/form")

local pause = {}

function pause.draw(c)
	local shared = c.shared
	if not shared.paused then
		return
	end
	local ui = c.ui
	if c.input.hits.escape then
		shared.paused = false
		-- Тот же Escape не должен открыть меню снова.
		shared.menuClosedAt = c.time
		return
	end
	ui:box({ anchor = { left = 0, right = 0, top = 0, bottom = 0 }, background = "rgb(8 17 28 / 0.6)" })
	-- Кнопки — списком через 6, как в главном меню.
	form.window(ui, { id = "pause", title = "Меню", width = math.min(300, ui.width - 32) }, function()
		ui:box({ direction = "column", align = "stretch", gap = 6 }, function()
			if form.button(ui, "pause:resume", "Продолжить", { primary = true }) then
				shared.paused = false
			end
			if c.app.menu and form.button(ui, "pause:exit", "Выйти в главное меню") then
				c.app:to_menu()
			end
		end)
	end)
end

return pause
