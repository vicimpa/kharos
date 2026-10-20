--!strict
-- Меню поверх партии: продолжить, настройки (lib/settings), сдаться и выйти в главное меню. Открывается кнопкой «Меню»
-- на верхней полосе и Escape, когда отменять нечего (controls/select); игра за ним идёт дальше, управление молчит
-- (c.shared.paused), Escape закрывает. Проигравшему — окно поражения: в главное меню или начать заново.

local defeat = require("lib/defeat")
local form = require("lib/form")
local settings = require("lib/settings")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS

local pause = {}
local settingsOpen = false
-- «Сдаться» нажато один раз: второе нажатие подтверждает.
local surrendering = false

-- Окно поражения под верхней полосой. Начать заново — новый мир этой же партии с теми же настройками, а на сервере —
-- новое место в этом мире.
local function defeated(c)
	local ui = c.ui
	ui:box({ anchor = { centerX = 0, top = 56 }, skin = "panel", padding = { 20, 28 }, direction = "column", align = "center", gap = 10 }, function()
		ui:text(c:t("game.defeat"), { font = "title", color = COLORS.bad })
		ui:text(c:t(if c.online then "game.defeatServer" else "game.defeatLocal"), { wrap = 360 })
		ui:box({ direction = "row", gap = 8 }, function()
			if c.app.menu and form.button(ui, "play:defeat:menu", c:t("common.toMenu")) then
				c.app:to_menu()
			end
			if form.button(ui, "play:defeat:again", c:t("game.startOver")) then
				c.shared.paused = false
				-- На сервере мир один на всех: начинают заново в новом месте этого мира.
				if c.online then
					c:send("respawn", {})
				else
					c.app:reset(c.app.options)
				end
			end
		end)
	end)
end

function pause.draw(c)
	local shared = c.shared
	local lost = c.tick > 0 and defeat.isDefeated(c, c.player)
	if lost then
		defeated(c)
	end
	if not shared.paused then
		surrendering = false
		return
	end
	local ui = c.ui
	if c.input.hits.escape then
		shared.paused = false
		settingsOpen = false
		surrendering = false
		-- Тот же Escape не должен открыть меню снова.
		shared.menuClosedAt = c.time
		return
	end
	ui:box({ anchor = { left = 0, right = 0, top = 0, bottom = 0 }, background = "rgb(8 17 28 / 0.6)" })
	if settingsOpen then
		if settings.window(c) then
			settingsOpen = false
		end
		return
	end
	-- Кнопки — списком через 6, как в главном меню.
	form.window(ui, { id = "pause", title = c:t("game.menu"), width = math.min(300, ui.width - 32) }, function()
		ui:box({ direction = "column", align = "stretch", gap = 6 }, function()
			if form.button(ui, "pause:resume", c:t("common.resume"), { primary = true }) then
				shared.paused = false
				settingsOpen = false
			end
			if form.button(ui, "pause:settings", c:t("common.settings")) then
				settingsOpen = true
			end
			if not lost then
				-- Сдаться — дважды: первое нажатие спрашивает, второе подтверждает.
				local tip = if surrendering then c:t("game.surrenderConfirm") else nil
				if form.button(ui, "pause:surrender", if surrendering then c:t("game.surrender") .. "?" else c:t("game.surrender"), { danger = true, tip = tip }) then
					if surrendering then
						c:send("surrender", {})
						shared.paused = false
					end
					surrendering = not surrendering
				end
			end
			-- Партия слота пишется сама; выход её ещё раз сохраняет.
			if c.app.menu and form.button(ui, "pause:exit", if c.app.slot then c:t("game.saveAndExit") else c:t("game.exitToMenu")) then
				c.app:to_menu()
			end
		end)
	end)
end

return pause
