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
-- Список «Первых шагов» (lib/steps): развёрнут, свёрнут или скрыт (STEPS_SHOWN).
settings.STEPS_SHOWN = { "open", "folded", "off" }
local STEPS_NAMES = { open = "Список", folded = "Свёрнут", off = "Скрыт" }
local DEFAULTS = { selection = 0.7, minimap = 200, steps = "open" }

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

-- Настройки интерфейса: яркость выделения, сторона мини-карты и список «Первых шагов».
function settings.prefs(c): { selection: number, minimap: number, steps: string }
	local saved = c.app:get("prefs") or {}
	return {
		selection = pick(saved.selection, settings.SELECTION_LEVELS, DEFAULTS.selection),
		minimap = pick(saved.minimap, settings.MINIMAP_SIDES, DEFAULTS.minimap),
		steps = pick(saved.steps, settings.STEPS_SHOWN, DEFAULTS.steps),
	}
end

function settings.setPref(c, key: string, value: any)
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
-- Графика (graphics.ts): доля пикселей мира, детализация земли, теней и осадков (0 — низкая, 1 — средняя, 2 — высокая) и
-- предел кадров (0 — без предела). Хранится в c.app под ключом graphics; рендер и окно читают её каждый кадр.
settings.PRESETS = {
	{ "low", "Низкое", { resolution = 0.5, terrain = 0, shadows = 0, weather = 0, fps = 30 } },
	{ "medium", "Среднее", { resolution = 0.75, terrain = 1, shadows = 1, weather = 1, fps = 60 } },
	{ "high", "Высокое", { resolution = 1, terrain = 2, shadows = 2, weather = 2, fps = 0 } },
}
settings.RESOLUTIONS = { 0.5, 0.75, 1 }
settings.FPS_LIMITS = { 30, 60, 0 }
local GRAPHICS_KEYS = { "resolution", "terrain", "shadows", "weather", "fps" }
local LEVEL_NAMES = { [0] = "Низкая", "Средняя", "Высокая" }

-- Настройки графики игрока; без сохранённого выбора — высокий набор.
function settings.graphics(c)
	local saved = c.app:get("graphics") or {}
	local value = table.clone(settings.PRESETS[3][3])
	for _, key in GRAPHICS_KEYS do
		if type(saved[key]) == "number" then
			value[key] = saved[key]
		end
	end
	return value
end

-- Какому набору соответствуют настройки; nil — подобраны вручную (presetOf).
local function presetOf(value): string?
	for _, preset in settings.PRESETS do
		local same = true
		for _, key in GRAPHICS_KEYS do
			same = same and preset[3][key] == value[key]
		end
		if same then
			return preset[1]
		end
	end
	return nil
end

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

		-- Графика: набор целиком или каждый эффект отдельно. Эффекты не выключаются — упрощаются; смена видна сразу.
		local value = settings.graphics(c)
		local preset = presetOf(value)
		form.groupTitle(ui, "Графика")
		ui:text("Качество", { color = COLORS.dim })
		local presets = {}
		for _, item in settings.PRESETS do
			table.insert(presets, { item[1], item[2] })
		end
		if not preset then
			table.insert(presets, { "custom", "Своё" })
		end
		local picked = form.chips(ui, "settings:preset", presets, preset or "custom", INNER, { fill = true })
		for _, item in settings.PRESETS do
			if picked == item[1] then
				c.app:set("graphics", table.clone(item[3]))
			end
		end
		local function set(key: string, level)
			local nextValue = settings.graphics(c)
			nextValue[key] = level
			c.app:set("graphics", nextValue)
		end
		local resolution = choice(ui, "settings:resolution", "Разрешение", "В скольких пикселях рисуется мир: меньше — быстрее, но пиксели крупнее. Интерфейс остаётся чётким.", settings.RESOLUTIONS, value.resolution, function(share)
			return string.format("%d%%", math.round(share * 100))
		end)
		if resolution then
			set("resolution", resolution)
		end
		for _, detail in { { "terrain", "Детализация земли", "Как ровно выглядит земля, когда камера далеко: выше — глаже, ниже — быстрее." }, { "shadows", "Точность теней", "Как точно фары ночью отбрасывают тени от зданий и техники." }, { "weather", "Детализация осадков", "Сколько капель, всплесков и слоёв снега видно в непогоду." } } do
			local level = choice(ui, "settings:" .. detail[1], detail[2], detail[3], { 0, 1, 2 }, value[detail[1]], function(level)
				return LEVEL_NAMES[level]
			end)
			if level then
				set(detail[1], level)
			end
		end
		local fps = choice(ui, "settings:fps", "Предел кадров", "Меньше кадров — меньше нагрев и расход батареи.", settings.FPS_LIMITS, value.fps, function(limit)
			return if limit > 0 then tostring(limit) else "Нет"
		end)
		if fps then
			set("fps", fps)
		end
		ui:text("Ниже — быстрее на слабых устройствах. Меняется сразу; наведи на название, чтобы узнать, что оно делает.", { color = COLORS.muted, wrap = INNER })

		-- Интерфейс: то, что дело вкуса, а не мощности устройства. Смена видна сразу.
		local prefs = settings.prefs(c)
		form.groupTitle(ui, "Интерфейс")
		local selection = choice(ui, "settings:selection", "Яркость выделения", "Насколько ярки кольца вокруг выбранных юнитов и рамки вокруг зданий", settings.SELECTION_LEVELS, prefs.selection, function(value)
			return string.format("%d%%", math.round(value * 100))
		end)
		if selection then
			settings.setPref(c, "selection", selection)
		end
		local minimap = choice(ui, "settings:minimap", "Размер мини-карты", "Сторона мини-карты в пикселях. 140 — вровень с нижней панелью, крупнее — выступает над ней", settings.MINIMAP_SIDES, prefs.minimap, tostring)
		if minimap then
			settings.setPref(c, "minimap", minimap)
		end
		local steps = choice(ui, "settings:steps", "Первые шаги", "Список первых шагов в правом верхнем углу игры", settings.STEPS_SHOWN, prefs.steps, function(value)
			return STEPS_NAMES[value]
		end)
		if steps then
			settings.setPref(c, "steps", steps)
		end
	end)
end

return settings
