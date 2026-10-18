--!strict
-- Настройки игрока — перенос packages/client/src/gui/screens/settings.ts, prefs.ts и хранения громкости из
-- audio/audio.ts: звук (выключить, общая громкость, громкость групп) и интерфейс (яркость выделения, сторона
-- мини-карты). Хранятся на диске (c.app:get и c.app:set); окно одно и в главном меню, и в меню партии.

local form = require("lib/form")

local settings = {}

-- Группы звука со своей громкостью: каждая ещё и под общей.
settings.CHANNELS = { "music", "battle", "world", "interface" }
local CHANNEL_NAMES = { music = "Музыка", battle = "Бой", world = "Мир", interface = "Интерфейс" }

-- Яркость колец и рамок выделения — доля от полной; сторона мини-карты с рамкой — 140 вровень с нижней панелью,
-- крупнее — выступает над ней.
settings.SELECTION_LEVELS = { 0.45, 0.7, 1 }
settings.MINIMAP_SIDES = { 140, 200, 260 }
local DEFAULTS = { selection = 0.7, minimap = 200 }

local WIDTH = 300
-- Подпись поля слева и ширина содержимого окна.
local LABEL = 88
local INNER = WIDTH - 36

local function share(value: any): number
	return if type(value) == "number" then math.clamp(value, 0, 1) else 1
end

local function pick(value: any, allowed: { any }, fallback: any): any
	return if table.find(allowed, value) then value else fallback
end

function settings.muted(c): boolean
	return c.app:get("muted") == true
end

function settings.volume(c): number
	return share(c.app:get("volume"))
end

function settings.level(c, channel: string): number
	return share(c.app:get("level." .. channel))
end

-- Настройки интерфейса: яркость выделения и сторона мини-карты.
function settings.prefs(c): { selection: number, minimap: number }
	local saved = c.app:get("prefs") or {}
	return {
		selection = pick(saved.selection, settings.SELECTION_LEVELS, DEFAULTS.selection),
		minimap = pick(saved.minimap, settings.MINIMAP_SIDES, DEFAULTS.minimap),
	}
end

local function setPrefs(c, key: string, value: any)
	local prefs = settings.prefs(c)
	prefs[key] = value
	c.app:set("prefs", prefs)
end

-- Выбор из вариантов с подписью сверху (узкое окно).
local function choice(ui, id: string, label: string, tip: string, values: { any }, value: any, name: (any) -> string): any
	ui:box({ id = id .. ":label" }, function()
		ui:text(label, { color = "#8fa9c2" })
	end)
	ui:tip(id .. ":label", tip)
	local options = {}
	for _, option in values do
		table.insert(options, { option, name(option) })
	end
	return form.chips(ui, id, options, value, INNER, { fill = true })
end

-- Окно настроек. Возвращает true, если нажали «Назад».
function settings.window(c, anchor: { [string]: number }?): boolean
	local ui = c.ui
	return form.window(ui, { id = "settings", title = "Настройки", width = WIDTH, back = "Назад", anchor = anchor }, function()
		form.groupTitle(ui, "Звук", true)
		local muted = settings.muted(c)
		local sound = form.checkbox(ui, "settings:muted", not muted, "Звук и музыка")
		if sound == muted then
			c.app:set("muted", not sound)
		end
		local volume = settings.volume(c)
		form.row(ui, "Общая", LABEL, function()
			local nextVolume = form.slider(ui, "settings:volume", volume, { min = 0, max = 1, step = 0.05, width = INNER - LABEL - 48 - 16, disabled = muted })
			if nextVolume ~= volume then
				c.app:set("volume", nextVolume)
			end
			ui:box({ width = 40, direction = "row", justify = "end" }, function()
				ui:text(string.format("%d%%", math.round(volume * 100)))
			end)
		end)
		-- Громкость групп — доля общей.
		for _, channel in settings.CHANNELS do
			local level = settings.level(c, channel)
			form.row(ui, CHANNEL_NAMES[channel], LABEL, function()
				local nextLevel = form.slider(ui, "settings:level:" .. channel, level, { min = 0, max = 1, step = 0.05, width = INNER - LABEL - 48 - 16, disabled = muted })
				if nextLevel ~= level then
					c.app:set("level." .. channel, nextLevel)
				end
				ui:box({ width = 40, direction = "row", justify = "end" }, function()
					ui:text(string.format("%d%%", math.round(level * 100)))
				end)
			end)
		end

		-- Интерфейс: то, что дело вкуса, а не мощности устройства. Смена видна сразу.
		local prefs = settings.prefs(c)
		form.groupTitle(ui, "Интерфейс")
		local selection = choice(ui, "settings:selection", "Яркость выделения", "Насколько ярки кольца вокруг выбранных юнитов и рамки вокруг зданий", settings.SELECTION_LEVELS, prefs.selection, function(value)
			return string.format("%d%%", math.round(value * 100))
		end)
		if selection then
			setPrefs(c, "selection", selection)
		end
		local minimap = choice(ui, "settings:minimap", "Размер мини-карты", "Сторона мини-карты в пикселях. 140 — вровень с нижней панелью, крупнее — выступает над ней", settings.MINIMAP_SIDES, prefs.minimap, tostring)
		if minimap then
			setPrefs(c, "minimap", minimap)
		end
	end)
end

return settings
