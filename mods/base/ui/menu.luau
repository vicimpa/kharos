--!strict
-- Главное меню — перенос packages/client/src/gui/screens/menu.ts: логотип, главное окно, новая игра (название, зерно,
-- размер карты, местность с готовыми вариантами и тонкой настройкой, сутки, начальное время, погода, схема карты) и
-- «Об игре». Те же окна, поля, кнопки и места.

local form = require("lib/form")
local settings = require("lib/settings")
local widgets = require("lib/widgets")
local COLORS = widgets.COLORS

local menu = {}

menu.data = {
	-- Какую партию начинает «Новая игра».
	game = "skirmish",
	-- Местность новой игры — вид из lands/.
	land = "desert",
	-- Какой стороны бывает карта новой игры, в тайлах; по умолчанию — средняя.
	sizes = { 512, 1024, 2048 },
	size = 1024,
	-- Сколько длятся сутки, секунд; 0 — время стоит.
	days = { 600, 1200, 2400, 0 },
	weather = { dayLength = 1200, startHour = 9, changes = true },
	repository = "https://github.com/vicimpa/kharos",
	authors = { { name = "vicimpa", url = "https://github.com/vicimpa" } },
	protocol = 52,
}

-- Уже скольких пикселей экран узкий: окна по центру, схема над полями.
local NARROW = 760

-- Готовые местности: отличия от генератора по умолчанию.
local PRESETS = {
	{ label = "Обычная", generator = {} },
	{ label = "Скалистая", generator = { rockLevel = 0.5, swampLevel = 0.3, peakChance = 0.5 } },
	{ label = "Пустыня", generator = { rockLevel = 0.68, swampLevel = 0.25, zoneScale = 80 } },
	{ label = "Болота", generator = { rockLevel = 0.62, swampLevel = 0.46, zoneWarp = 50 } },
	{ label = "Острова", generator = { rockLevel = 0.6, swampLevel = 0.5, zoneScale = 40, zoneWarp = 10 } },
}

-- Ползунки местности для человека: доля от 0 до 1 переводится в параметр генератора и обратно.
local KNOBS = {
	-- Чем ниже уровень скал, тем их больше: ползунок «больше» вправо.
	{ key = "rockLevel", from = 0.75, to = 0.45, label = "Скалы", tip = "Сколько скал: на них строят, на них лежит руда" },
	{ key = "swampLevel", from = 0.2, to = 0.5, label = "Болота", tip = "Сколько болот: по ним не проехать" },
	{ key = "zoneScale", from = 24, to = 120, label = "Размер зон", tip = "Крупные плато и пустыни или мелкая мозаика" },
	{ key = "zoneWarp", from = 0, to = 80, label = "Изрезанность", tip = "Округлые пятна или рваные края" },
	{ key = "biomeScale", from = 80, to = 600, label = "Размер биомов", tip = "Как далеко тянутся солончаки, красные пустоши и топи" },
	{ key = "peakChance", from = 0, to = 1, label = "Горы", tip = "Сколько гор на скалах: сквозь них не проехать и не построить" },
}

local PEAK_RADIUS_LIMIT = 2

local function biomeFields(prefix: string)
	return {
		{ key = prefix .. "SwampShift", label = "Больше болот", min = -0.2, max = 0.2, step = 0.005 },
		{ key = prefix .. "RockShift", label = "Меньше скал", min = -0.2, max = 0.2, step = 0.005 },
		{ key = prefix .. "PeakFactor", label = "Гор, раз", min = 0, max = 4, step = 0.1 },
	}
end

-- Группы тонкой настройки генератора.
local GROUPS = {
	{
		title = "Зоны",
		fields = {
			{ key = "biomeScale", label = "Размер биомов", min = 40, max = 600, step = 10 },
			{ key = "zoneScale", label = "Размер зон", min = 16, max = 160, step = 1 },
			{ key = "zoneWarp", label = "Изрезанность", min = 0, max = 80, step = 1 },
			{ key = "swampLevel", label = "Уровень болот", min = 0, max = 1, step = 0.005 },
			{ key = "rockLevel", label = "Уровень скал", min = 0, max = 1, step = 0.005 },
		},
	},
	{
		title = "Горы",
		fields = {
			{ key = "peakChance", label = "Частота", min = 0, max = 1, step = 0.01 },
			{ key = "peakMinRadius", label = "Мин. радиус", min = 0.5, max = PEAK_RADIUS_LIMIT, step = 0.05 },
			{ key = "peakMaxRadius", label = "Макс. радиус", min = 0.5, max = PEAK_RADIUS_LIMIT, step = 0.05 },
			{ key = "doubleChance", label = "Доля двойных", min = 0, max = 1, step = 0.01 },
			{ key = "tripleChance", label = "Доля тройных", min = 0, max = 1, step = 0.01 },
		},
	},
	{
		title = "Месторождения",
		fields = {
			{ key = "depositChance", label = "Частота", min = 0, max = 1, step = 0.01 },
			{ key = "depositRichness", label = "Запас, раз", min = 0.1, max = 5, step = 0.1 },
		},
	},
	{ title = "Биом: солончаки", fields = biomeFields("salt") },
	{ title = "Биом: красные пустоши", fields = biomeFields("red") },
	{ title = "Биом: топи", fields = biomeFields("marsh") },
}

local function clock(hour: number): string
	return string.format("%02d:%02d", math.floor(hour), math.floor((hour % 1) * 60))
end

-- Число без хвостовых нулей — как String(number) у страницы.
local function plain(value: number): string
	if value == math.floor(value) then
		return tostring(math.floor(value))
	end
	return tostring(math.round(value * 1e6) / 1e6)
end

local screen = "main"
local game: any = nil
local seeds = 0
-- Сохранения: подтверждение удаления, переименование.
local confirming: string? = nil
local renaming: { id: string, name: string }? = nil

-- Симуляция идёт 20 тиков в секунду: время игры по тику слота.
local function playtime(tick: number): string
	local minutes = math.floor(tick / 20 / 60)
	if minutes < 60 then
		return string.format("%d мин", minutes)
	end
	return string.format("%d ч %d мин", math.floor(minutes / 60), minutes % 60)
end

local function slotOf(c, id: string?)
	if not id then
		return nil
	end
	for _, slot in c.app:saves() do
		if slot.id == id then
			return slot
		end
	end
	return nil
end

local function randomSeed(c): number
	seeds += 1
	return math.floor(c.hash(c.time * 1000, seeds, 7) * 2 ^ 31)
end

-- Генератор по умолчанию — данные местности новой игры.
local function defaults(c)
	return c.protos.lands[menu.data.land].data
end

-- Новая игра.
local function fresh(c)
	local generator = table.clone(defaults(c))
	generator.seed = randomSeed(c)
	return { name = string.format("Игра %d", #c.app:saves() + 1), size = menu.data.size, weather = table.clone(menu.data.weather), generator = generator, fine = false }
end

-- Отличия местности от генератора по умолчанию, без зерна: их и получает партия.
local function generatorChanges(c, config): { [string]: any }
	local changes = {}
	for key, value in defaults(c) do
		if key ~= "seed" and config[key] ~= value then
			changes[key] = config[key]
		end
	end
	return changes
end

local function count(map: { [string]: any }): number
	local n = 0
	for _ in map do
		n += 1
	end
	return n
end

local function open(c, nextScreen: string)
	screen = nextScreen
	if nextScreen == "new" then
		game = fresh(c)
	end
	if nextScreen == "saves" then
		confirming = nil
		renaming = nil
	end
end

-- Место окна: у широкого экрана — слева, у узкого — по центру; над окном — логотип.
local function place(ui)
	local top = math.max(16, math.min(120, ui.height * 0.12)) + 76
	return if ui.width < NARROW then { centerX = 0, top = top } else { left = 56, top = top }
end

local function logoRow(c)
	local ui = c.ui
	local narrow = ui.width < NARROW
	local top = math.max(16, math.min(120, ui.height * 0.12))
	ui:box({ anchor = if narrow then { centerX = 0, top = top } else { left = 56, top = top }, width = if narrow then nil else 300, direction = "row", align = "center", justify = "center", gap = 12, passive = true }, function()
		ui:image(c.protos.icons.logo, 44, 44)
		ui:box({ direction = "row", gap = 8 }, function()
			for _, letter in { "K", "H", "A", "R", "O", "S" } do
				ui:text(letter, { font = "logo", color = COLORS.bright, shadow = COLORS.ink, lift = 4 })
			end
		end)
	end)
end

local function mainWindow(c)
	local ui = c.ui
	local width = if ui.width < NARROW then math.min(280, ui.width - 32) else 300
	form.window(ui, { id = "menu:main", title = "Главное меню", width = width, anchor = place(ui) }, function()
		ui:box({ direction = "column", align = "stretch", gap = 6 }, function()
			-- Продолжать нечего — кнопки нет, а не мёртвая серая. Есть что — это и есть главное действие.
			local last = slotOf(c, c.app.last)
			if last and form.button(ui, "menu:resume", "Продолжить", { primary = true, tip = last.name .. " — " .. playtime(last.tick) }) then
				c.app:play(last.id)
			end
			if form.button(ui, "menu:new", "Новая игра") then
				open(c, "new")
			end
			if form.button(ui, "menu:saves", "Сохранения") then
				open(c, "saves")
			end
			if form.button(ui, "menu:settings", "Настройки") then
				open(c, "settings")
			end
			if form.button(ui, "menu:about", "Об игре") then
				open(c, "about")
			end
		end)
		form.link(ui, c.app, "menu:github", "GitHub", menu.data.repository, true)
	end)
end

-- Ползунки тонкой настройки по группам: каждая — в утопленной рамке. Возвращает новые значения или nil.
local function generatorGroups(ui, values, width: number)
	local nextValues = nil
	for _, group in GROUPS do
		ui:box({ skin = "well", padding = { 8, 10 }, direction = "column", gap = 6, width = width }, function()
			ui:text(group.title, { color = COLORS.dim })
			for _, field in group.fields do
				local value = (nextValues or values)[field.key]
				form.row(ui, field.label, 96, function()
					local moved = form.slider(ui, "gen:" .. field.key, value, { min = field.min, max = field.max, step = field.step, width = width - 20 - 96 - 48 - 16 })
					if moved ~= value then
						nextValues = table.clone(nextValues or values)
						nextValues[field.key] = moved
					end
					ui:box({ width = 48, direction = "row", justify = "end" }, function()
						ui:text(plain(value))
					end)
				end)
			end
		end)
	end
	return nextValues
end

-- Схема карты с подписью размера и долей скал и болот.
local function previewBox(c, side: number)
	local ui = c.ui
	ui:box({ direction = "column", align = "center", gap = 6 }, function()
		local result
		ui:box({ skin = "well", padding = 4 }, function()
			result = ui:preview(c.protos.lands[menu.data.land], generatorChanges(c, game.generator), game.generator.seed, game.size, side, side)
		end)
		local text = string.format("%d×%d тайлов", game.size, game.size)
		if result.ready then
			text ..= string.format(" · скалы %d%% · болота %d%%", math.round(result.rock * 100), math.round(result.swamp * 100))
		end
		ui:text(text, { color = COLORS.muted, wrap = side })
	end)
end

local function newGameWindow(c)
	local ui = c.ui
	local width = math.min(900, ui.width - 32)
	local narrow = ui.width < NARROW
	local inner = width - 36
	local aside = 328
	local formWidth = if narrow then inner else inner - aside - 16
	local changes = generatorChanges(c, game.generator)
	local preset = nil
	for _, option in PRESETS do
		local same = count(changes) == count(option.generator)
		for key, value in option.generator do
			if changes[key] ~= value then
				same = false
			end
		end
		if same then
			preset = option
		end
	end
	local start = false
	-- В редактор — мир без игроков (newWorldWindow в menu.ts: «В редактор»).
	local edit = false
	local back = form.window(ui, {
		id = "menu:new",
		title = "Новая игра",
		width = width,
		anchor = place(ui),
		back = "Назад",
		actions = function()
			if form.button(ui, "menu:new:edit", "В редактор", { tip = "Править карту, базы, юнитов, деньги и склады до начала игры" }) then
				start, edit = true, true
			end
			if form.button(ui, "menu:new:start", "Начать", { primary = true }) then
				start = true
			end
		end,
	}, function()
		local function fields()
			ui:box({ direction = "column", align = "stretch", gap = 10, width = formWidth }, function()
				form.above(ui, "Название", function()
					local name = form.textField(ui, "menu:new:name", game.name, { maxLength = 40 })
					game.name = name.value
					if table.find(name.keys, "Enter") then
						start = true
					end
				end)
				form.above(ui, "Зерно карты", function()
					ui:box({ direction = "row", align = "center", gap = 6 }, function()
						local seed = form.numberField(ui, "menu:new:seed", game.generator.seed, {})
						if seed then
							game.generator.seed = math.floor(seed)
						end
						if form.button(ui, "menu:new:random", "Случайно", { tip = "Другая случайная местность с теми же настройками" }) then
							game.generator.seed = randomSeed(c)
						end
					end)
				end)
				form.above(ui, "Размер карты", function()
					local options = {}
					for _, size in menu.data.sizes do
						table.insert(options, { size, tostring(size) })
					end
					local size = form.chips(ui, "menu:new:size", options, game.size, formWidth)
					if size then
						game.size = size
					end
				end)
				form.above(ui, "Местность", function()
					local options = {}
					for _, option in PRESETS do
						table.insert(options, { option, option.label })
					end
					local picked = form.chips(ui, "menu:new:preset", options, preset, formWidth)
					if picked then
						local seed = game.generator.seed
						game.generator = table.clone(defaults(c))
						for key, value in picked.generator do
							game.generator[key] = value
						end
						game.generator.seed = seed
					end
				end)
				for _, knob in KNOBS do
					local share = math.clamp((game.generator[knob.key] - knob.from) / (knob.to - knob.from), 0, 1)
					form.row(ui, knob.label, 150, function()
						local moved = form.slider(ui, "menu:new:knob:" .. knob.key, share, { min = 0, max = 1, step = 0.01, width = formWidth - 158 - 56 })
						if moved ~= share then
							game.generator[knob.key] = math.round((knob.from + moved * (knob.to - knob.from)) * 1000) / 1000
						end
						ui:box({ width = 48, direction = "row", justify = "end" }, function()
							ui:text(tostring(math.round(share * 100)))
						end)
					end, knob.tip, "menu:new:knobLabel:" .. knob.key)
				end
				game.fine = form.details(ui, "menu:new:fine", "Тонкая настройка местности", game.fine, function()
					local tuned = generatorGroups(ui, game.generator, formWidth)
					if tuned then
						game.generator = tuned
					end
				end)
				form.above(ui, "Сутки длятся", function()
					local options = {}
					for _, seconds in menu.data.days do
						table.insert(options, { seconds, if seconds > 0 then string.format("%d мин", seconds / 60) else "Стоят" })
					end
					local day = form.chips(ui, "menu:new:day", options, game.weather.dayLength, formWidth)
					if day then
						game.weather.dayLength = day
					end
				end)
				form.row(ui, "Начальное время", 150, function()
					local hour = form.slider(ui, "menu:new:hour", game.weather.startHour, { min = 0, max = 23.5, step = 0.5, width = formWidth - 158 - 56 })
					game.weather.startHour = hour
					ui:box({ width = 48, direction = "row", justify = "end" }, function()
						ui:text(clock(game.weather.startHour))
					end)
				end)
				game.weather.changes = form.checkbox(ui, "menu:new:weather", game.weather.changes, "Погода меняется: ветер, дожди и бури")
			end)
		end
		local function side()
			previewBox(c, if narrow then inner else 320)
		end
		ui:box({ direction = if narrow then "column" else "row", gap = 16, align = if narrow then "center" else "start" }, function()
			if narrow then
				side()
				fields()
			else
				fields()
				side()
			end
		end)
	end)
	if back then
		screen = "main"
	end
	if start then
		local name = string.gsub(game.name, "^%s*(.-)%s*$", "%1")
		if name == "" then
			name = string.format("Игра %d", #c.app:saves() + 1)
		end
		-- Новая игра — новый слот сохранений: мир заведётся по этим настройкам и дальше пишется сам.
		local slot = c.app:create(name, menu.data.game, {
			seed = game.generator.seed,
			-- Карта партии — от −size до size по обеим осям.
			size = game.size / 2,
			generator = generatorChanges(c, game.generator),
			weather = game.weather,
		})
		if slot and edit then
			c.app:edit(slot)
		elseif slot then
			c.app:play(slot)
		end
	end
end

local function saveRow(c, slot, width: number)
	local ui = c.ui
	local id = "save:" .. slot.id
	local options = slot.options or {}
	ui:box({ skin = "well", padding = 12, direction = "column", gap = 8 }, function()
		ui:box({ direction = "column", gap = 2 }, function()
			if renaming and renaming.id == slot.id then
				local field = form.textField(ui, id .. ":name", renaming.name, { width = width - 24, maxLength = 40, focus = true })
				renaming.name = field.value
				local trimmed = string.gsub(renaming.name, "^%s*(.-)%s*$", "%1")
				if table.find(field.keys, "Enter") and trimmed ~= "" then
					c.app:rename(slot.id, trimmed)
					renaming = nil
				elseif table.find(field.keys, "Escape") or table.find(field.keys, "Blur") then
					renaming = nil
				end
			else
				ui:text(slot.name, { color = COLORS.bright, wrap = true })
			end
			local size = (options.size or 0) * 2
			ui:text(string.format("%s · %s · карта %d · зерно %d", c.app:date(slot.updated), playtime(slot.tick), size, options.seed or 0), { font = "small", color = COLORS.muted, wrap = true })
		end)
		ui:box({ direction = "row", gap = 6, wrap = true }, function()
			if form.button(ui, id .. ":play", "Играть", { primary = true }) then
				c.app:play(slot.id)
			end
			-- Редактор — когда у слота есть мир: в него уже играли или его сохранил редактор.
			if form.button(ui, id .. ":editor", "Редактор", { disabled = slot.updated == slot.created, tip = "Править мир: карту, базы, юнитов, деньги и склады" }) and slot.updated ~= slot.created then
				c.app:edit(slot.id)
			end
			if form.button(ui, id .. ":rename", "Имя") then
				renaming = { id = slot.id, name = slot.name }
			end
			if confirming == slot.id then
				if form.button(ui, id .. ":sure", "Точно?", { danger = true }) then
					c.app:remove(slot.id)
					confirming = nil
				end
			elseif form.button(ui, id .. ":remove", "Удалить") then
				confirming = slot.id
			end
		end)
	end)
end

local function savesWindow(c)
	local ui = c.ui
	local width = math.min(560, ui.width - 32)
	local inner = width - 36
	local saves = c.app:saves()
	local back = form.window(ui, { id = "menu:saves", title = "Сохранения", width = width, anchor = place(ui), back = "Назад" }, function()
		if #saves == 0 then
			ui:text("Сохранений нет. Начните новую игру.", { color = COLORS.muted, wrap = true })
		end
		for _, slot in saves do
			saveRow(c, slot, inner)
		end
	end)
	if back then
		screen = "main"
	end
end

local function aboutWindow(c)
	local ui = c.ui
	local width = if ui.width < NARROW then math.min(280, ui.width - 32) else 300
	local back = form.window(ui, { id = "menu:about", title = "Об игре", width = width, anchor = place(ui), back = "Назад" }, function()
		ui:text("Многопользовательская браузерная RTS: машина-основатель, процедурная карта, добыча и переработка руды, грузовая логистика и оборона базы.", { wrap = true })
		ui:text(ui:upper("Авторы"), { color = COLORS.muted })
		for _, author in menu.data.authors do
			form.link(ui, c.app, "about:" .. author.name, author.name, author.url)
		end
		ui:text(ui:upper("Исходный код"), { color = COLORS.muted })
		form.link(ui, c.app, "about:repo", "github.com/vicimpa/kharos", menu.data.repository)
		ui:text(string.format("Версия протокола %d", menu.data.protocol), { color = COLORS.muted })
	end)
	if back then
		screen = "main"
	end
end

function menu.draw(c)
	logoRow(c)
	if screen == "main" then
		mainWindow(c)
	elseif screen == "new" then
		newGameWindow(c)
	elseif screen == "about" then
		aboutWindow(c)
	elseif screen == "saves" then
		savesWindow(c)
	elseif screen == "settings" then
		local ui = c.ui
		if settings.window(c, place(ui)) then
			screen = "main"
		end
	end
end

return menu
