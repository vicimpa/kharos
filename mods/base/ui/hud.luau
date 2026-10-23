--!strict
-- Панель игрока: верхняя полоса и нижняя — мини-карта, сведения о выбранном, сетка команд 4 × 3; уведомления, первые
-- шаги, полоса режима и награды. Сетку, сведения и то, что поверх поля, дают куски механик (lib/panel), режимы —
-- управление (modes).

local widgets = require("lib/widgets")
local panel = require("lib/panel")
local stats = require("lib/stats")
local economy = require("lib/economy")
local goods = require("lib/goods")
local logistics = require("lib/logistics")
local research = require("lib/research")
local tactics = require("lib/tactics")
local alertsLib = require("lib/alerts")
local missiles = require("lib/missiles")
local stepsLib = require("lib/steps")
local paving = require("lib/paving")
local seenLib = require("lib/seen")
local wallet = require("lib/wallet")

local COLORS, shadow = widgets.COLORS, widgets.shadow

local hud = {}

-- Окна по краям поля (макет «Адаптивный интерфейс», docs/adaptive-ui.md): отступ от края, верхние блоки, ячейки
-- команд, ширина выбранного.
local GUT = 8
local TOP_GUT = 6
local TOP_H = 40
local TOP_BOTTOM = panel.TOP
local GAP = 4
local CELL_H = 44
local SEL_W = 360
local PIC = 48
local STEPS_W = 300
local TILE = 32
local settings = require("lib/settings")
local GRID_KEYS = { "T", "Y", "U", "I", "G", "H", "J", "K", "B", "N", "M", "," }
-- С какой доли выработки полная нагрузка сети уже тесна: число энергии на полосе желтеет.
local GRID_TIGHT = 0.8

-- Раскладка окон на этот кадр по размеру окна игры:
--   компьютер — команды 4×3 справа снизу, выбранное слева от них (wide) или над ними;
--   стоя — команды доком снизу во всю ширину, выбранное над ними;
--   телефон лёжа (ниже 500) — команды колонкой 2×6 справа, выбранное слева снизу.
-- Мини-карта — сторона из настроек, но не больше трети короткой стороны экрана.
type Layout = { mm: number, cols: number, cell: number, cellH: number, act: number, sel: number, wide: boolean, column: boolean, compact: boolean }
local function layout(c): Layout
	local width, height = c.ui.width, c.ui.height
	local mm = math.min(settings.prefs(c).minimap, math.floor(math.min(width, height) * 0.3))
	if height < 500 and width > height then
		local act = 316
		return { mm = mm, cols = 2, cell = (act - 20 - GAP) / 2, cellH = CELL_H, act = act, sel = math.min(SEL_W, width - act - 3 * GUT), wide = true, column = true, compact = false }
	end
	if height > width then
		local act = width - 2 * GUT
		local cell = math.floor((act - 20 - 3 * GAP) / 4)
		local compact = cell < 120
		return { mm = mm, cols = 4, cell = cell, cellH = if compact then 68 else 52, act = act, sel = act, wide = false, column = false, compact = compact }
	end
	local cell = 172
	if SEL_W + 4 * cell + 3 * GAP + 20 + 3 * GUT <= width then
		return { mm = mm, cols = 4, cell = cell, cellH = CELL_H, act = 4 * cell + 3 * GAP + 20, sel = SEL_W, wide = true, column = false, compact = false }
	end
	cell = math.clamp(math.floor((width - 2 * GUT - 20 - 3 * GAP) / 4), 80, 156)
	local act = 4 * cell + 3 * GAP + 20
	return { mm = mm, cols = 4, cell = cell, cellH = CELL_H, act = act, sel = math.min(SEL_W, act), wide = false, column = false, compact = false }
end

-- Пульс подсказки «Первых шагов»: обводка огнями команды разгорается и гаснет раз в секунду от low до high; восемь
-- ступеней — плавнее не разглядеть.
local function pulse(ui, low: number, high: number, color: string?, period: number?): string
	local phase = (ui.now / (period or 1)) % 1
	local level = math.round((low + (high - low) * (0.5 - 0.5 * math.cos(phase * math.pi * 2))) * 8) / 8
	return string.format("rgba(%s / %g)", color or "90 169 255", level)
end

local currentStep, number, goodWith, goodsRow = panel.currentStep, panel.number, panel.goodWith, panel.goodsRow
local KEY_NAMES = { "t", "y", "u", "i", "g", "h", "j", "k", "b", "n", "m", "," }

-- Цвет энергии сети: нехватка или перегруз — красный, тесно при полной нагрузке — жёлтый.
local function gridColor(grid): string
	return if grid.demand > grid.produced or grid.overload then COLORS.bad elseif grid.peak > grid.produced * GRID_TIGHT then COLORS.warn else COLORS.power
end

-- Энергия сети строкой: «⚡ спрос/выработка» и полоска нагрузки с отметкой пика.
local function powerLine(ui, grid)
	local color = gridColor(grid)
	ui:text("⚡ " .. number(grid.demand) .. "/" .. number(grid.produced), { color = color })
	local load = if grid.produced > 0 then math.clamp(grid.demand / grid.produced, 0, 1) else (if grid.demand > 0 then 1 else 0)
	local peak = if grid.produced > 0 then math.clamp(grid.peak / grid.produced, 0, 1) else 0
	ui:box({ width = 48, height = 8, background = COLORS.ink, padding = 1, direction = "stack" }, function()
		ui:box({ width = 46, height = 6, background = COLORS.well })
		ui:box({ self = { "start", "start" }, width = math.max(0, math.round(46 * load)), height = 6, background = color })
		if peak > 0 then
			ui:box({ self = { "start", "start" }, padding = { 0, 0, 0, math.min(44, math.round(46 * peak)) } }, function()
				ui:box({ width = 2, height = 6, background = COLORS.bright })
			end)
		end
	end)
end

-- Сеть в беде — для полосы: нехватка энергии или перегруз; nil — все сети в порядке.
local function troubleGrid(c)
	for _, zone in economy.zones(c, c.player) do
		local grid = panel.gridState(zone)
		if grid.demand > grid.produced or grid.overload then
			return grid
		end
	end
	return nil
end

local function topBar(c)
	local ui = c.ui
	local right = ui:rect("top:r")
	local room = ui.width - 3 * TOP_GUT - (if right then right.width else 320)
	-- Левый блок: кредиты, защита новичка, энергия, запас; не шире, чем оставляет правый.
	ui:box({ id = "top:l", anchor = { left = TOP_GUT, top = TOP_GUT }, height = TOP_H, maxWidth = room, skin = "panel", padding = { 0, 10 }, direction = "row", align = "center", gap = 12, clip = true }, function()
		ui:box({ id = "credits", direction = "row", align = "center", gap = 6 }, function()
			widgets.coin(ui)
			ui:text(tostring(math.floor(wallet.credits(c, c.player))), { font = "title", color = COLORS.gold, shadow = COLORS.ink, lift = 2 })
			local income = math.round(economy.of(c, c.player).income * 100) / 100
			if income > 0 then
				ui:text(c:t("hud.perSecond", { amount = number(income) }), { color = COLORS.good })
			end
		end)
		ui:tip("credits", c:t("common.credits"))
		-- Защита новичка: сколько осталось, до десятков секунд.
		local record = wallet.of(c, c.player)
		local safe = record and c:get(record, "Player").safe or 0
		if safe > c.tick then
			local seconds = math.ceil((safe - c.tick) * c.step / 10) * 10
			ui:box({ id = "protection" }, function()
				ui:text(c:t("hud.protection", { left = string.format("%d:%02d", seconds // 60, seconds % 60) }), { color = COLORS.good })
			end)
			ui:tip("protection", c:t("hud.protectionTip"))
		end
		-- Энергию и запас зоны показывает сводка у складов и станций (zoneTip); на полосе — только сеть в беде.
		local grid = troubleGrid(c)
		if grid then
			ui:box({ id = "grid", direction = "row", align = "center", gap = 6 }, function()
				powerLine(ui, grid)
			end)
			ui:tip("grid", panel.gridText(c, grid))
		end
	end)
	-- Правый блок: часы, исследования, меню.
	ui:box({ id = "top:r", anchor = { right = TOP_GUT, top = TOP_GUT }, height = TOP_H, skin = "panel", padding = { 0, 6, 0, 10 }, direction = "row", align = "center", gap = 10 }, function()
		local hour = c.atmosphere.hour or 0
		ui:box({ id = "clock", direction = "row", gap = 4 }, function()
			ui:text(string.format("%02d:%02d", math.floor(hour), math.floor(hour * 60) % 60), { color = COLORS.dim })
		end)
		ui:tip("clock", c:t("hud.clock"))
		-- Кнопка исследований: нынешняя тема с процентом и полоской; без темы — «Исследования». Открывает дерево
		-- технологий.
		local current = research.current(c, c.player)
		local state = research.player(c, c.player)
		local topic = current and research.topic(c, current)
		local progress = if current and state then ((state.progress or {})[current] or 0) else nil
		local narrow = ui.width < 1200
		-- Подсказка «Первых шагов»: следующий шаг — исследовать тему.
		local hint = (currentStep(c) or {}).research
		if ui:button("tech", { active = c.shared.techOpen == true, padding = { 0, 10, 0, 8 }, height = 30, gap = 6, outline = if hint then pulse(ui, 0.3, 1) else nil, direction = "stack" }, function()
			ui:box({ self = { "start", "center" }, direction = "row", align = "center", gap = 6 }, function()
				if topic and progress and not narrow then
					ui:text(c:t(topic.data.title), shadow())
				elseif not progress then
					ui:text(c:t("grid.techTree"), shadow())
				end
				if progress then
					ui:text(math.round(progress * 100) .. "%", shadow({ color = COLORS.team }))
				end
				ui:box({ background = COLORS.ink, padding = { 0, 3 } }, function()
					ui:text("R", { color = COLORS.gold })
				end)
			end)
			if progress then
				ui:box({ self = { "stretch", "end" }, height = 2, background = COLORS.well, direction = "row" }, function()
					ui:box({ grow = progress, background = COLORS.team })
					ui:box({ grow = 1 - progress })
				end)
			end
		end) then
			c.shared.techOpen = not c.shared.techOpen
		end
		ui:tip("tech", if topic then c:t(topic.data.title) .. "\n" .. c:t("tech.openTip") else c:t("tech.openTip"))
		-- Меню — значком из трёх полос.
		if ui:button("menu", { width = 30, height = 30, padding = 0, direction = "column", align = "center", justify = "center", gap = 3 }, function()
			for _ = 1, 3 do
				ui:box({ width = 14, height = 2, background = COLORS.text })
			end
		end) then
			c.shared.paused = true
		end
		ui:tip("menu", c:t("game.menuTip"))
	end)
end
-- Ячейки сетки команд для выбранного: их собирают куски панели механик (lib/panel) по порядку; кусок, который забирает
-- сетку целиком (подтверждение), отдаёт её сам.
local function slots(c, selection)
	local list = {}
	local view = { selection = selection, builders = panel.builders(c, selection), root = true, exclusive = nil }
	for _, part in panel.parts(c.protos, "slots") do
		part.fn(c, list, view)
		if view.exclusive then
			return view.exclusive
		end
	end
	return list
end

-- Карточка ячейки: название с клавишей, пояснение, параметры юнита, цена.
local function card(ui, c, slot, hotkey: string)
	local WIDTH = 316
	ui:box({ direction = "column", gap = 4, width = WIDTH, align = "stretch" }, function()
		ui:box({ direction = "row", justify = "between", align = "end", gap = 12 }, function()
			ui:text(slot.label, { font = "title", color = COLORS.bright })
			ui:text(hotkey, { font = "title", color = COLORS.gold })
		end)
		if slot.about then
			ui:text(slot.about, { color = COLORS.dim, wrap = WIDTH })
		end
		if slot.title then
			ui:text(slot.title, { color = if slot.about and slot.disabled then COLORS.warn else COLORS.dim, wrap = WIDTH })
		end
		if slot.unit then
			for _, row in stats.unit(c, slot.unit) do
				ui:box({ direction = "row", gap = 10 }, function()
					ui:box({ width = 90 }, function()
						ui:text(row.label, { color = COLORS.dim })
					end)
					ui:text(row.value)
				end)
			end
		end
		if slot.cost or slot.power then
			ui:box({ direction = "row", align = "center", gap = 10 }, function()
				if slot.cost then
					ui:box({ direction = "row", align = "center", gap = 4 }, function()
						widgets.coin(ui)
						ui:text(if slot.gain then "+" .. slot.cost else tostring(slot.cost), { color = if slot.gain then COLORS.good else COLORS.gold })
					end)
				end
				if slot.power then
					ui:text("⚡" .. (if slot.power > 0 then "+" .. number(slot.power) else number(slot.power)), { color = COLORS.power })
					if slot.idle then
						ui:text(c:t("grid.idlePower", { idle = number(slot.idle) }), { color = COLORS.dim })
					end
				end
			end)
		end
		-- Материалы: значок, название и сколько нужно; не хватает в хранилищах — сколько есть из нужного.
		if slot.materials then
			for _, name in goods.names(c) do
				local amount = slot.materials[name]
				local kind = c.protos.goods[name]
				if amount and kind then
					local stored = math.floor(slot.stock[name] or 0)
					local short = stored < amount
					ui:box({ direction = "row", align = "center", gap = 6 }, function()
						ui:image(kind, 16, 16)
						ui:box({ grow = 1 }, function()
							ui:text(c:t(kind.data.title), { ellipsis = true })
						end)
						ui:text(if short then stored .. "/" .. amount else tostring(amount), { color = if short then COLORS.warn else COLORS.text })
					end)
				end
			end
		end
	end)
end

-- Ширина карточки ячейки с полями окна.
local CARD_W = 316 + 24

-- Подсказка и лист ячейки — прямо над ней, серединой к ней, но не за краем экрана.
local function cellAnchor(c, id: string): { [string]: number }?
	local rect = c.ui:rect(id)
	if not rect then
		return nil
	end
	local left = math.clamp(math.floor(rect.x + rect.width / 2 - CARD_W / 2), GUT, math.max(GUT, c.ui.width - CARD_W - GUT))
	return { left = left, bottom = c.screen.h - rect.y + 6 }
end

-- Где встаёт подсказка ячейки: над окном выбранного, если оно над командами, иначе над командами — правым краем к
-- краю экрана.
local function cardAnchor(c): { [string]: number }?
	local ui = c.ui
	local above = ui:rect("sel")
	local act = ui:rect("act")
	local top = if act then act.y else nil
	if above and act and above.y + above.height <= act.y + 1 then
		top = above.y
	end
	return if top then { right = GUT, bottom = c.screen.h - top + GUT } else nil
end

-- Текст по словам в строки не шире width, не больше max; что не влезло — многоточием в последней. Строки ставят
-- по одной: так их можно выровнять по середине.
local function lines(ui, text: string, width: number, max: number): { string }
	local out, line = {}, ""
	for word in string.gmatch(text, "%S+") do
		local candidate = if line == "" then word else line .. " " .. word
		if line ~= "" and ui:measure(candidate, "small") > width then
			table.insert(out, line)
			line = word
		else
			line = candidate
		end
	end
	if line ~= "" then
		table.insert(out, line)
	end
	local cut = #out > max
	if cut then
		out = table.move(out, 1, max, 1, {})
	end
	-- Длинное слово или хвост — с многоточием по ширине.
	for i, value in out do
		if ui:measure(value, "small") <= width and not (cut and i == max) then
			continue
		end
		while utf8.len(value) > 1 and ui:measure(value .. "…", "small") > width do
			value = string.sub(value, 1, utf8.offset(value, -1) - 1)
		end
		out[i] = value .. "…"
	end
	return out
end

-- Узкая ячейка (телефон стоя): значок сверху, под ним название мелко в две строки, цена — в правом верхнем углу.
local function compactCell(c, slot, id: string, hotkey: string, place: Layout, outline: string?)
	local ui = c.ui
	return ui:button(id, { width = place.cell, height = place.cellH, padding = 0, direction = "stack", active = slot.active, disabled = slot.disabled, outline = outline }, function()
		ui:box({ self = { "center", "start" }, direction = "column", align = "center", gap = 2, padding = { 6, 2, 0, 2 } }, function()
			if slot.picture then
				ui:box({ width = TILE, height = TILE }, function()
					ui:image(slot.picture, TILE, TILE)
				end)
			end
			for _, line in lines(ui, slot.label, place.cell - 6, 2) do
				ui:text(line, shadow({ font = "small", color = COLORS.bright }))
			end
		end)
		if slot.cost then
			ui:box({ self = { "end", "start" }, background = "rgb(11 17 27 / 0.85)", padding = { 1, 2 }, direction = "row", align = "center", gap = 2 }, function()
				widgets.coin(ui, 10)
				ui:text(if slot.gain then "+" .. slot.cost else tostring(slot.cost), { font = "small", color = if slot.gain then COLORS.good elseif slot.short then COLORS.warn else COLORS.gold })
			end)
		end
	end)
end

-- Ячейка команд: значок с клавишей в углу, название, цена и энергия; подсказка — карточкой над окнами.
local function commandGrid(c, list, place: Layout)
	local ui = c.ui
	local cell, cellH = place.cell, place.cellH
	ui:box({ id = "commands", direction = "column", gap = GAP }, function()
		for row = 0, 12 // place.cols - 1 do
			ui:box({ direction = "row", gap = GAP }, function()
				for column = 0, place.cols - 1 do
					local i = row * place.cols + column + 1
					local slot = list[i]
					local hotkey = GRID_KEYS[i]
					if not slot then
						ui:box({ width = cell, height = cellH, skin = "well", alpha = 0.35 })
						continue
					end
					local id = "cell:" .. i
					-- Подсказка шага — синим, новая кнопка — золотом.
					local outline = if slot.hint and not slot.disabled then pulse(ui, 0.3, 1) elseif slot.fresh and not slot.disabled then pulse(ui, 0.2, 0.95, "240 201 90", 1.6) else nil
					local keyColor = if slot.disabled then COLORS.muted else COLORS.gold
					local click = if place.compact then compactCell(c, slot, id, hotkey, place, outline) else ui:button(id, { width = cell, height = cellH, padding = { 0, 6, 0, if slot.picture then 4 else 8 }, gap = 8, justify = "start", active = slot.active, disabled = slot.disabled, outline = outline }, function()
						if slot.picture then
							ui:box({ direction = "stack" }, function()
								ui:box({ width = TILE, height = TILE }, function()
									ui:image(slot.picture, TILE, TILE)
								end)
								ui:box({ self = { "start", "start" }, background = COLORS.ink, padding = { 0, 2 } }, function()
									widgets.key(ui, hotkey, keyColor)
								end)
							end)
						end
						ui:box({ direction = "column", grow = 1, gap = 0, clip = true }, function()
							ui:box({ direction = "row", gap = 6 }, function()
								ui:box({ grow = 1 }, function()
									ui:text(slot.label, shadow({ color = COLORS.bright, ellipsis = true }))
								end)
								if not slot.picture then
									widgets.key(ui, hotkey, keyColor)
								end
							end)
							ui:box({ direction = "row", align = "center", gap = 4 }, function()
								if slot.cost then
									widgets.coin(ui, 12)
									ui:text(if slot.gain then "+" .. slot.cost else tostring(slot.cost), shadow({ color = if slot.gain then COLORS.good elseif slot.short then COLORS.warn else COLORS.gold }))
								elseif slot.count then
									ui:text(tostring(slot.count), shadow({ color = COLORS.dim }))
								end
								if slot.power then
									ui:space(0, 0, 1)
									ui:text("⚡" .. (if slot.power > 0 then "+" .. number(slot.power) else number(slot.power)), shadow({ color = COLORS.power }))
								end
							end)
						end)
						if slot.lamp ~= nil then
							ui:box({ width = 6, height = 6, background = if slot.lamp then COLORS.good else COLORS.bad })
						end
					end)
					if not c.shared.sheet then
						ui:tip(id, function()
							card(ui, c, slot, hotkey)
						end, cellAnchor(c, id))
					end
					-- Пока смотрят кнопку здания, на карте видны границы зон (controls/build).
					if slot.zones and ui:hovered(id) then
						c.shared.zonesHover = true
					end
					-- Навели на новую кнопку — она знакома.
					if slot.fresh and slot.seen and ui:hovered(id) then
						seenLib.mark(c, slot.seen)
					end
					-- Долгое касание (и правая кнопка) — лист подробностей: на сенсорном экране наведения нет, иначе не
					-- узнать, что это за кнопка.
					if click and click.button == 2 then
						c.shared.sheet = { index = i, label = slot.label, first = (c.shared.selection or {})[1] }
					elseif click or (c.input.hits[KEY_NAMES[i]] and not c.input.keys.ctrl and not slot.disabled) then
						c.shared.sheet = nil
						slot.run()
					end
				end
			end)
		end
	end)
end

-- Лист подробностей ячейки по долгому касанию: карточка, как у подсказки, и кнопки — сделать и закрыть. Закрывается и
-- сам: сменился выбор, ячейки больше нет, коснулись карты.
local function sheetWindow(c, list)
	local sheet = c.shared.sheet
	if not sheet then
		return
	end
	local ui = c.ui
	local slot = list[sheet.index]
	local input = c.input
	if not slot or slot.label ~= sheet.label or (c.shared.selection or {})[1] ~= sheet.first or (input.pressed.left and input.inside and not input.over_ui) then
		c.shared.sheet = nil
		return
	end
	ui:box({ id = "sheet", anchor = cellAnchor(c, "cell:" .. sheet.index) or cardAnchor(c), skin = "panel", padding = 12, direction = "column", gap = 10, align = "stretch" }, function()
		card(ui, c, slot, GRID_KEYS[sheet.index])
		ui:box({ direction = "row", gap = 6 }, function()
			if ui:button("sheet:run", { grow = 1, height = 44, padding = { 0, 12 }, skin = if slot.disabled then nil else "button-primary", disabled = slot.disabled }, function()
				ui:text(slot.label, shadow({ ellipsis = true }))
			end) then
				c.shared.sheet = nil
				slot.run()
			end
			if ui:button("sheet:close", { width = 44, height = 44, padding = 0 }, function()
				ui:text("✕", shadow())
			end) then
				c.shared.sheet = nil
			end
		end)
	end)
end

-- Заголовок выбранного: название (стройка, разбор, состав отряда), строка параметров юнита.
local function selectionTitle(c, selection): string
	local first = selection[1]
	local kind = c:proto(first)
	local title = if kind and kind.data then c:t(kind.data.title) or kind.name else "?"
	if #selection == 1 then
		local site = c:get(first, "Site")
		if site then
			title = c:t(if site.undo then "hud.undoing" elseif site.demolish then "hud.demolition" else "hud.construction", { name = title })
		end
		return title
	end
	local counts, order = {}, {}
	for _, e in selection do
		local k = c:proto(e)
		local name = k and c:t(k.data.title) or "?"
		if not counts[name] then
			counts[name] = 0
			table.insert(order, name)
		end
		counts[name] += 1
	end
	local parts = {}
	for _, name in order do
		table.insert(parts, if counts[name] > 1 then name .. " ×" .. counts[name] else name)
	end
	return table.concat(parts, ", ")
end

-- Доля прочности выбранных: у одного — его, у многих — общая.
local function healthOf(c, selection): number?
	local value, max = 0, 0
	for _, e in selection do
		local health = c:get(e, "Health")
		if health then
			value += health.value
			max += health.max
		end
	end
	return if max > 0 then value / max else nil
end

-- Окно выбранного: портрет (у отряда — плитки видов с числом), название, параметры и полоска прочности; ниже —
-- куски панели механик (lib/panel): склад, энергия, работа, очередь.
local function info(c, selection, width: number)
	local ui = c.ui
	local many = #selection > 1
	local first = selection[1]
	local kind = c:proto(first)
	local title = selectionTitle(c, selection)
	local site = not many and c:get(first, "Site")
	local text = width - 20 - (if many then 0 else PIC + 10)
	local unitKind = if not many and c:has(first, "Unit") then kind else nil
	ui:box({ id = "info", direction = "column", gap = 6, align = "stretch" }, function()
		ui:box({ direction = "row", align = "center", gap = 10 }, function()
			if not many then
				ui:button("portrait", { width = PIC, height = PIC, padding = 0, skin = "well", direction = "stack" }, function()
					ui:box({ self = { "center", "center" } }, function()
						ui:image(kind, PIC - 8, PIC - 8)
					end)
				end)
				ui:tip("portrait", c:t("hud.showOnMap"))
				if ui:clicked("portrait") then
					local at = c:get(first, "Position")
					if at then
						c.shared.flyTo = { x = at.x, y = at.y }
					end
				end
			end
			ui:box({ direction = "column", gap = 3, width = text }, function()
				ui:box({ id = "info:title", width = text }, function()
					ui:text(title, { color = COLORS.bright, shadow = COLORS.ink, lift = 1, ellipsis = true })
				end)
				ui:tip("info:title", if many then title elseif unitKind then stats.text(c, unitKind) else "")
				if unitKind then
					ui:box({ id = "info:stats", width = text }, function()
						ui:text(stats.line(c, unitKind), { color = COLORS.dim, ellipsis = true })
					end)
					ui:tip("info:stats", stats.text(c, unitKind))
				end
				local health = not site and healthOf(c, selection)
				if health then
					ui:box({ width = text, height = 6, background = COLORS.ink, padding = 1, direction = "row" }, function()
						ui:box({ grow = health, height = 4, background = "#4fd07a" })
						ui:box({ grow = 1 - health, height = 4, background = COLORS.well })
					end)
				end
			end)
		end)
		-- Отряд: плитки видов с числом; щелчок оставляет выбранными только этот вид.
		if many then
			local order, groups = {}, {}
			for _, e in selection do
				local k = c:proto(e)
				if k and not groups[k] then
					groups[k] = {}
					table.insert(order, k)
				end
				if k then
					table.insert(groups[k], e)
				end
			end
			ui:box({ id = "info:units", direction = "row", gap = 4, width = width - 20, clip = true }, function()
				for index, k in order do
					local id = "unit:" .. index
					if ui:button(id, { width = 40, height = 40, padding = 0, skin = "well", direction = "stack" }, function()
						ui:box({ self = { "center", "center" } }, function()
							ui:image(k, TILE, TILE)
						end)
						if #groups[k] > 1 then
							ui:box({ self = { "end", "end" }, padding = { 0, 2, 1, 0 } }, function()
								ui:text(tostring(#groups[k]), shadow({ color = COLORS.bright }))
							end)
						end
					end) then
						c.shared.selection = groups[k]
					end
					ui:tip(id, c:t(k.data.title))
				end
			end)
		end
		local view = { selection = selection, first = first, kind = kind, many = many, site = site, width = width - 20 }
		view.built = not many and not site and kind and c:has(first, "Building")
		for _, part in panel.parts(c.protos, "info") do
			part.fn(c, view)
		end
	end)
end

-- Режим (стройка, патруль, маршрут) — на месте команд: что за режим, что делать, «Отмена» и «Готово». Esc и правая
-- кнопка работают и так, но на сенсорном экране их нет.
local function modeWindow(c, spec, width: number)
	local ui = c.ui
	local mode = c.shared.mode
	local name, tip = spec.describe(c, mode)
	ui:box({ id = "mode", direction = "column", gap = 6, align = "stretch", width = width - 20 }, function()
		ui:text(name, { color = COLORS.team, wrap = width - 20 })
		ui:text(tip, { color = COLORS.soft, wrap = width - 20 })
		ui:box({ direction = "row", gap = 6 }, function()
			if ui:button("mode:cancel", { grow = 1, height = 36, padding = { 0, 10 }, gap = 6 }, function()
				ui:text(c:t("mode.cancel"), shadow())
				ui:box({ background = COLORS.ink, padding = { 0, 3 } }, function()
					ui:text("Esc", { color = COLORS.gold })
				end)
			end) then
				c.shared.mode = nil
			end
			ui:tip("mode:cancel", c:t("mode.endTip"))
			if spec.done then
				if ui:button("mode:done", { grow = 1, height = 36, padding = { 0, 10 }, gap = 6, skin = "button-primary" }, function()
					ui:text(c:t("mode.done"), shadow())
					ui:box({ background = COLORS.ink, padding = { 0, 3 } }, function()
						ui:text("Enter", { color = COLORS.gold })
					end)
				end) then
					spec.done(c)
				end
				ui:tip("mode:done", c:t("mode.doneTip"))
			end
		end)
	end)
end


-- Мини-карта: местность, здания и юниты цветом стороны, рамка экрана; левая кнопка (и протяжка) ставит туда камеру,
-- правая шлёт выделенных.
local SIDE_COLORS = { own = "#5aa9ff", foe = "#ff6b5a", neutral = "#c8c8c8" }

-- Уведомления этого кадра (lib/alerts): их строки в ленте и кольца на мини-карте.
local shownAlerts: { alertsLib.Alert } = {}

local function minimapView(c, side: number)
	local ui = c.ui
	local size = (c.game.data and c.game.data.size) or 64
	local span = size * 2
	local inner = side - 8
	local scale = inner / span
	local k = inner / 132
	local dot = math.max(2, math.round(2 * k))
	local function at(x: number, y: number): (number, number)
		return (x + size) * scale, (y + size) * scale
	end
	ui:box({ id = "minimap", width = side, height = side, skin = "well", padding = 4, clip = true }, function()
		ui:box({ direction = "stack", width = inner, height = inner, background = "#05090f" }, function()
			ui:image("minimap", inner, inner)
			-- Месторождения — цветом своего ресурса: видимые и запомненные.
			local function deposit(px: number, py: number, kind)
				if kind and kind.data.color then
					local x, y = at(px, py)
					ui:box({ self = { "start", "start" }, padding = { math.floor(y - dot / 2), 0, 0, math.floor(x - dot / 2) } }, function()
						ui:box({ width = dot, height = dot, background = kind.data.color })
					end)
				end
			end
			for _, e in c:each({ "Deposit", "Position" }) do
				if c:visible(e) then
					local p = c:get(e, "Position")
					deposit(p.x, p.y, c:proto(e))
				end
			end
			-- Чужие здания в тумане — какими их видели (призраки памяти).
			local ghosts = c:ghosts()
			for _, ghost in ghosts do
				if ghost.parts.Deposit then
					deposit(ghost.x, ghost.y, ghost.kind)
				elseif ghost.parts.Building then
					local owner = ghost.parts.Owner and ghost.parts.Owner.player or 0
					local x, y = at(ghost.x, ghost.y)
					local w, h = math.max(dot, ghost.width * scale), math.max(dot, ghost.height * scale)
					ui:box({ self = { "start", "start" }, padding = { math.floor(y - h / 2), 0, 0, math.floor(x - w / 2) } }, function()
						ui:box({ width = w, height = h, background = if owner == 0 then SIDE_COLORS.neutral else SIDE_COLORS.foe })
					end)
				end
			end
			for _, e in c:each({ "Owner", "Position" }) do
				local building = c:get(e, "Building")
				if (building or c:has(e, "Unit")) and c:visible(e) then
					local owner = c:get(e, "Owner").player
					local color = if owner == c.player then SIDE_COLORS.own elseif owner == 0 then SIDE_COLORS.neutral else SIDE_COLORS.foe
					local p = c:get(e, "Position")
					local x, y = at(p.x, p.y)
					local w, h = dot, dot
					if building then
						w, h = math.max(dot, building.width * scale), math.max(dot, building.height * scale)
					end
					ui:box({ self = { "start", "start" }, padding = { math.floor(y - h / 2), 0, 0, math.floor(x - w / 2) } }, function()
						ui:box({ width = w, height = h, background = color })
					end)
				end
			end
			-- Метки ядерного удара, которые игрок видит: место пуска — крестик, точка удара — круг взрыва; ракеты в
			-- полёте — белые точки.
			local function mark(x: number, y: number, w: number, h: number, color: string, alpha: number?)
				ui:box({ self = { "start", "start" }, padding = { math.floor(y - h / 2), 0, 0, math.floor(x - w / 2) } }, function()
					ui:box({ width = w, height = h, background = color, alpha = alpha })
				end)
			end
			local function ring(x: number, y: number, radius: number, color: string, alpha: number?)
				local count = math.max(12, math.floor(radius * 2))
				for i = 0, count - 1 do
					local a = i / count * math.pi * 2
					mark(x + math.cos(a) * radius, y + math.sin(a) * radius, dot, dot, color, alpha)
				end
			end
			local blast = c.protos.buildings.silo.data.warhead.blast
			for _, e in c:each({ "Mark", "Position" }) do
				local m = c:get(e, "Mark")
				if m.player ~= c.player and not tactics.allied(c, c.player, m.player) and not table.find(m.viewers or {}, c.player) then
					continue
				end
				local p = c:get(e, "Position")
				local x, y = at(p.x, p.y)
				if m.kind == "launch" then
					local arm = math.round(4 * k)
					for step = -arm, arm, math.max(1, math.round(k)) do
						mark(x + step, y + step, dot, dot, "#ffb347")
						mark(x + step, y - step, dot, dot, "#ffb347")
					end
				elseif m.kind == "strike" then
					ring(x, y, math.max(4 * k, blast.radius * scale), SIDE_COLORS.foe)
				end
			end
			local speed = c.protos.buildings.silo.data.warhead.speed
			for _, e in c:each({ "Missile" }) do
				local mx, my = missiles.at(c:get(e, "Missile"), c.tick, c.step, speed)
				local x, y = at(mx, my)
				mark(x, y, math.round(3 * k), math.round(3 * k), "#ffffff")
			end
			-- Уведомления: мигающее кольцо там, где напали или заметили врага.
			for _, alert in shownAlerts do
				local pulse = (alertsLib.age(alert) * 2) % 1
				local color = if alert.kind == "attacked" or alert.kind == "nuke" then SIDE_COLORS.foe elseif alert.kind == "ping" then "#4ec973" elseif alert.kind == "found" or alert.kind == "intercepted" then "#8fe0a8" else "#ffd27a"
				local x, y = at(alert.x, alert.y)
				ring(x, y, (3 + pulse * 12) * k, color, 1 - pulse)
			end
			-- Рамка экрана.
			local x1, y1 = c:to_world(0, 0)
			local x2, y2 = c:to_world(c.screen.w, c.screen.h)
			local left, top = at(x1, y1)
			local right, bottom = at(x2, y2)
			local line = math.max(1, math.round(k))
			local w, h = math.round(right - left), math.round(bottom - top)
			for _, piece in { { left, top, w, line }, { left, top + h - line, w, line }, { left, top, line, h }, { left + w - line, top, line, h } } do
				ui:box({ self = { "start", "start" }, padding = { math.round(piece[2]), 0, 0, math.round(piece[1]) } }, function()
					ui:box({ width = piece[3], height = piece[4], background = "#e4f4ff" })
				end)
			end
		end)
	end)
	local held = ui:held("minimap")
	local click = ui:clicked("minimap")
	local function tile(u: number, v: number): (number, number)
		return -size + u * span, -size + v * span
	end
	if held then
		c.camera.x, c.camera.y = tile(held[1], held[2])
	end
	if click and click.button == 2 then
		local rect = ui:rect("minimap")
		local input = c.input
		if rect then
			local u = math.clamp((input.x - rect.x - 4) / (rect.width - 8), 0, 1)
			local v = math.clamp((input.y - rect.y - 4) / (rect.height - 8), 0, 1)
			local x, y = tile(u, v)
			local units = {}
			for _, e in c.shared.selection or {} do
				if c:has(e, "Mover") then
					table.insert(units, e)
				end
			end
			if #units > 0 then
				c:send("move", { units = units, x = x, y = y })
			end
		end
	end
end

-- Нижние окна: мини-карта слева снизу; справа снизу команды (или режим), выбранное — слева от них на широком экране и
-- над ними на узком. Ничего не выбрано и нет режима — окна команд нет, карта открыта.
local function bottomWindows(c)
	local ui = c.ui
	local selection = c.shared.selection or {}
	local selected = #selection > 0
	local place = layout(c)
	-- Мини-карта — слева сверху, под левым блоком полосы; первые шаги и уведомления — под ней.
	ui:box({ id = "mm", anchor = { left = GUT, top = TOP_BOTTOM + GUT } }, function()
		minimapView(c, place.mm)
	end)
	local mode = c.shared.mode
	local spec = mode and panel.mode(c.protos, mode.kind)
	local list = if selected then slots(c, selection) else {}
	local commands = spec ~= nil or next(list) ~= nil
	if commands then
		ui:box({ id = "act", anchor = { right = GUT, bottom = GUT }, width = place.act, skin = "panel", padding = 10, direction = "column", gap = GAP }, function()
			if spec then
				modeWindow(c, spec, place.act)
			else
				commandGrid(c, list, place)
			end
		end)
	end
	if selected and not spec then
		-- Высота сетки — по раскладке, а не по прошлому кадру: в первом кадре выбора окна команд ещё не было, и
		-- выбранное легло бы на него.
		local rows = 12 // place.cols
		local actHeight = if commands then rows * place.cellH + (rows - 1) * GAP + 20 else 0
		local anchor = if place.column then { left = GUT, bottom = GUT } elseif place.wide then { right = GUT + (if commands then place.act + GUT else 0), bottom = GUT } else { right = GUT, bottom = GUT + (if commands then actHeight + GUT else 0) }
		ui:box({ id = "sel", anchor = anchor, width = place.sel, skin = "panel", padding = 10, direction = "column" }, function()
			info(c, selection, place.sel)
		end)
	end
	if spec then
		c.shared.sheet = nil
	else
		sheetWindow(c, list)
	end
end

-- Верх того, что стоит слева под мини-картой.
local function belowMinimap(c): number
	return TOP_BOTTOM + GUT + layout(c).mm + GUT
end

-- Узкий экран (телефон стоя): карточка шагов — справа от мини-карты, уведомления и награды — под ними обеими.
local NARROW = 600

-- Верх того, что стоит справа под карточкой шагов (уведомления, награды на узком экране).
local function belowSteps(c): number
	local steps = c.ui:rect("steps")
	local top = if steps and c.shared.stepsDrawn then steps.y + steps.height + GUT else TOP_BOTTOM + GUT
	if c.ui.width < NARROW then
		top = math.max(top, belowMinimap(c))
	end
	return top
end

-- Сколько секунд после последнего шага карточка поздравляет, прежде чем скрыться.
local STEPS_FAREWELL = 8

-- Видна ли карточка «Первых шагов»: не скрыта в настройках и шаги не пройдены — пройденные при входе в мир не видны
-- совсем, пройденные в игре — ещё STEPS_FAREWELL секунд.
local function stepsShown(c): boolean
	if settings.prefs(c).steps == "off" then
		return false
	end
	local done = stepsLib.of(c).done
	local finished = table.find(done, false) == nil
	if c.shared.stepsKnown == nil then
		c.shared.stepsKnown = finished
	end
	if not finished then
		c.shared.stepsFinishedAt = nil
		return true
	end
	if c.shared.stepsKnown then
		return false
	end
	c.shared.stepsFinishedAt = c.shared.stepsFinishedAt or c.time
	return c.time - c.shared.stepsFinishedAt < STEPS_FAREWELL
end

-- Первые шаги новичка — компактной карточкой справа сверху, под правым блоком полосы: карта важнее. Свёрнутая —
-- одна строка «2/12 Название шага ▸» и деления пройденного; касание по ней разворачивает: что сделать (первое
-- предложение подсказки), зачем (остальное, мельче) и «Показать». На маленьком экране свёрнута, пока не развернут.
-- Мир, где всё уже пройдено при входе, карточки не показывает.
local function stepsPanel(c)
	c.shared.stepsDrawn = false
	if not stepsShown(c) then
		return
	end
	-- Телефон лёжа: пока что-то выбрано, справа колонка команд — карточке не хватает места.
	if c.ui.height < 500 and #(c.shared.selection or {}) > 0 then
		return
	end
	c.shared.stepsDrawn = true
	local ui = c.ui
	local state = stepsLib.of(c)
	local done, target = state.done, state.target
	local small = ui.width < NARROW or ui.height < 700
	local open = settings.prefs(c).steps == "open" and (not small or c.shared.stepsOpened == true)
	local current = table.find(done, false)
	local count = 0
	for _, passed in done do
		if passed then
			count += 1
		end
	end
	-- Ширина: на узком экране — всё справа от мини-карты.
	local width = if ui.width < NARROW then ui.width - layout(c).mm - 3 * GUT else math.min(STEPS_W, ui.width - 2 * GUT)
	local text = width - 20
	local step = current and stepsLib.LIST[current]
	ui:box({ id = "steps", anchor = { right = GUT, top = TOP_BOTTOM + GUT }, width = width, skin = "panel", padding = { 4, 10, 8, 10 }, direction = "column", align = "stretch", gap = 4 }, function()
		-- Заголовок во всю ширину: касание сворачивает и разворачивает.
		ui:box({ id = "steps:toggle", height = 28, direction = "row", align = "center", gap = 6 }, function()
			ui:text(count .. "/" .. #done, { color = COLORS.gold })
			ui:box({ grow = 1 }, function()
				ui:text(if step then c:t(step.title) else c:t("steps.title"), { color = COLORS.bright, shadow = COLORS.ink, lift = 1, ellipsis = true })
			end)
			ui:text(if open then "▾" else "▸", { color = if ui:hovered("steps:toggle") then COLORS.bright else COLORS.dim })
		end)
		ui:tip("steps:toggle", c:t("steps.title") .. " — " .. (if open then c:t("steps.foldTip") else c:t("steps.unfoldTip")))
		if ui:clicked("steps:toggle") then
			c.shared.stepsOpened = not open
			settings.setPref(c, "steps", if open then "folded" else "open")
		end
		ui:box({ direction = "row", gap = 2 }, function()
			for i, passed in done do
				ui:box({ grow = 1, height = 3, background = if passed then COLORS.good elseif i == current then COLORS.team else COLORS.steel })
			end
		end)
		if not step then
			ui:text(c:t("steps.finished"), { color = COLORS.good, wrap = text })
			return
		end
		if not open then
			return
		end
		-- Подсказка: первое предложение — что сделать, остальное — зачем.
		local tip = c:t(step.tip)
		local stop, after = string.find(tip, "[%.!]%s+")
		ui:space(0, 2)
		ui:text(if stop then string.sub(tip, 1, stop) else tip, { color = COLORS.text, wrap = text })
		if after then
			ui:text(string.sub(tip, after + 1), { font = "small", color = COLORS.dim, wrap = text })
		end
		if target then
			ui:space(0, 2)
			ui:box({ direction = "row" }, function()
				if ui:button("steps:show", { height = 36, padding = { 0, 14 }, skin = "button-primary" }, function()
					ui:text(c:t("steps.show"), shadow())
				end) then
					c.shared.flyTo = { x = target.x + target.width / 2, y = target.y + target.height / 2 }
				end
			end)
			ui:tip("steps:show", c:t("steps.showTip"))
		end
	end)
end

-- Сколько секунд сообщение о награде висит на экране.
local TOAST_SECONDS = 5

-- Награды под полосой режима: монета, сумма и за что; mechanics/economy кладёт их в c.shared.rewards.
local function rewards(c)
	local list = c.shared.rewards or {}
	local learned = c.shared.learned or {}
	for _, items in { list, learned } do
		for i = #items, 1, -1 do
			if c.time - items[i].time > TOAST_SECONDS then
				table.remove(items, i)
			end
		end
	end
	if #list == 0 and #learned == 0 then
		return
	end
	local ui = c.ui
	local anchor = if ui.width < NARROW then { centerX = 0, top = belowSteps(c) } else { centerX = 0, top = TOP_BOTTOM + GUT }
	ui:box({ anchor = anchor, direction = "column", align = "center", gap = 6 }, function()
		if #list > 0 then
			ui:box({ skin = "gold", padding = { 10, 14 }, direction = "column", gap = 4 }, function()
				for _, toast in list do
					ui:box({ direction = "row", align = "center", gap = 6 }, function()
						widgets.coin(ui)
						ui:text("+" .. toast.credits, { color = COLORS.gold })
						ui:text(toast.title)
					end)
				end
			end)
		end
		-- Исследованное и открытое: что тема дала; щелчок — дерево технологий.
		local room = math.min(ui.width - 24, 640)
		-- Видны последние: на узком экране одно, иначе три; про остальные — «+N». Открытий в начале партии сразу
		-- несколько, столбик закрыл бы поле.
		local shown = if ui.width < NARROW then 1 else 3
		local first = math.max(1, #learned - shown + 1)
		if first > 1 then
			ui:box({ skin = "panel", padding = { 2, 10 } }, function()
				ui:text("+" .. (first - 1), { color = COLORS.team })
			end)
		end
		for i = first, #learned do
			local toast = learned[i]
			local kind = research.topic(c, toast.topic)
			if not kind then
				continue
			end
			local left = (TOAST_SECONDS - (c.time - toast.time)) / TOAST_SECONDS
			local buildings, units = research.unlocks(c, toast.topic)
			local opens = {}
			for _, other in buildings do
				table.insert(opens, c:t(other.data.title))
			end
			for _, other in units do
				table.insert(opens, c:t(other.data.title))
			end
			for _, kind in paving.opens(toast.topic) do
				table.insert(opens, c:t(paving.TITLES[kind]))
			end
			local id = "learned:" .. i
			if ui:button(id, { skin = "panel", direction = "column", align = "center", gap = 2, padding = { 10, 16 }, alpha = if left > 0.2 then 1 else math.round((0.3 + (left / 0.2) * 0.7) * 8) / 8 }, function()
				ui:box({ direction = "row", gap = 6 }, function()
					ui:text(if toast.trigger then c:t("hud.discovered") else c:t("hud.researched"))
					ui:text(c:t(kind.data.title), { color = COLORS.team })
				end)
				if #opens > 0 then
					ui:text(c:t("hud.opens", { list = table.concat(opens, ", ") }), { color = COLORS.soft, wrap = room - 32 })
				end
			end) then
				c.shared.techOpen = true
			end
			ui:tip(id, c:t("tech.openTip"))
		end
	end)
end

-- Уведомления справа сверху, под карточкой шагов: каждое — своей строкой с маркером цвета вида; щелчок ведёт камеру
-- к месту. Со временем гаснут.
local ALERT_COLORS = { attacked = COLORS.bad, spotted = COLORS.warn, found = COLORS.good, ping = COLORS.ally }
local function alertList(c)
	local list = shownAlerts
	if #list == 0 then
		return
	end
	local ui = c.ui
	local seconds = alertsLib.data.seconds
	local anchor = { right = GUT, top = belowSteps(c) }
	ui:box({ anchor = anchor, width = if ui.width < NARROW then ui.width - 2 * GUT else STEPS_W, direction = "column", gap = 2, align = "stretch" }, function()
		for _, alert in list do
			local age = alertsLib.age(alert)
			local bright = seconds * 0.75
			local fade = if age < bright then 1 else math.max(0.25, 1 - 0.75 * (age - bright) / (seconds - bright))
			local id = "alert:" .. alert.at
			local color = ALERT_COLORS[alert.kind] or COLORS.text
			ui:box({ id = id, skin = "panel", height = 32, direction = "row", align = "center", gap = 8, padding = { 0, 14 }, alpha = math.round(fade * 8) / 8 }, function()
				ui:box({ width = 8, height = 8, background = COLORS.ink, padding = 1 }, function()
					ui:box({ width = 6, height = 6, background = color })
				end)
				ui:text(c:t(alertsLib.TEXTS[alert.text] or alert.text), { color = color, shadow = COLORS.ink, ellipsis = true })
			end)
			ui:tip(id, c:t("hud.showPlace"))
			if ui:clicked(id) then
				c.shared.flyTo = { x = alert.x, y = alert.y }
			end
		end
	end)
end

-- Сводка зоны у склада, электростанции или главного здания: энергия сети и запас её хранилищ. Мышь — наведением,
-- касание — удержанием пальца (наведения нет).
local HOLD = 0.45
local HOLD_SLOP = 12
local hold: { x: number, y: number, time: number }? = nil

-- Точка экрана, над которой спрашивают сводку: указатель над картой или удержанный палец; nil — нигде.
local function askedAt(c): (number?, number?)
	local input = c.input
	if not input.touch then
		hold = nil
		if input.inside and not input.over_ui then
			return input.x, input.y
		end
		return nil, nil
	end
	if input.pressed.left and input.inside and not input.over_ui then
		hold = { x = input.x, y = input.y, time = c.time }
	end
	if not (hold and input.down.left) then
		hold = nil
		return nil, nil
	end
	if math.abs(input.x - hold.x) + math.abs(input.y - hold.y) > HOLD_SLOP then
		hold.time = math.huge
	end
	if c.time - hold.time < HOLD then
		return nil, nil
	end
	return hold.x, hold.y
end

-- Своё готовое здание под точкой мира, о зоне которого есть что сказать: склад, станция, главное здание.
local function zoneBuildingAt(c, wx: number, wy: number): number?
	for _, e in c:each({ "Building", "Position" }) do
		if not c:mine(e) or c:has(e, "Site") then
			continue
		end
		local size = c:get(e, "Building")
		local at = c:get(e, "Position")
		if math.abs(wx - at.x) <= size.width / 2 and math.abs(wy - at.y) <= size.height / 2 then
			local kind = c:proto(e)
			if kind and (logistics.isStore(c, e) or (kind.data.power or 0) > 0 or kind.name == economy.CORE) then
				return e
			end
			return nil
		end
	end
	return nil
end

local function zoneTip(c, view)
	if view.tip or c.shared.mode then
		return
	end
	local x, y = askedAt(c)
	if not x then
		return
	end
	local wx, wy = c:to_world(x, y)
	local e = zoneBuildingAt(c, wx, wy)
	if not e then
		return
	end
	local index, zone = economy.gridOf(c, e)
	if not index or not zone then
		return
	end
	view.tip = true
	local ui = c.ui
	local grid = panel.gridState(zone)
	-- Запас хранилищ этой сети.
	local items, capacity = {}, 0
	for _, book in economy.books(c) do
		if book.economy == zone then
			for _, member in book.grid.members do
				if logistics.isStore(c, member) and c:mine(member) and not c:has(member, "Site") then
					local stock = c:get(member, "Inventory")
					capacity += stock.capacity
					for good, amount in stock.items do
						items[good] = (items[good] or 0) + amount
					end
				end
			end
		end
	end
	local WIDTH = 280
	-- У пальца — над ним, чтобы не закрыл; у мыши — правее и ниже указателя.
	local anchor = if c.input.touch then { centerX = math.clamp(x - ui.width / 2, -ui.width / 2 + WIDTH / 2 + GUT, ui.width / 2 - WIDTH / 2 - GUT), bottom = c.screen.h - y + 32 }
		elseif x > ui.width - WIDTH - 40 then { right = ui.width - x + 16, top = y + 16 }
		else { left = x + 16, top = y + 16 }
	ui:box({ anchor = anchor, width = WIDTH, skin = "panel", padding = { 8, 12 }, direction = "column", gap = 6, passive = true }, function()
		ui:text(c:t(c:proto(e).data.title), { color = COLORS.bright, shadow = COLORS.ink, lift = 1 })
		ui:text(panel.gridText(c, grid), { color = gridColor(grid), wrap = WIDTH - 24 })
		if capacity > 0 then
			goodsRow(c, items, c:t("hud.storesEmpty"))
			ui:text(c:t("hud.stockTip", { capacity = capacity }), { color = COLORS.dim, wrap = WIDTH - 24 })
		end
	end)
end

-- Части самой панели по местам (lib/panel.LAYERS); между ними — куски механик поверх поля.
local LAYERS = {
	{ at = panel.LAYERS.alerts, fn = function(c)
		alertList(c)
	end },
	{ at = panel.LAYERS.steps, fn = stepsPanel },
	{ at = panel.LAYERS.rewards, fn = rewards },
	{ at = panel.LAYERS.top, fn = topBar },
	{ at = panel.LAYERS.top + 5, fn = zoneTip },
	{ at = panel.LAYERS.bottom, fn = bottomWindows },
}

function hud.draw(c)
	-- Окна плавают по краям, карта видна целиком: камера едет у самых краёв экрана.
	c.shared.inset = { top = 0, bottom = 0, left = 0, right = 0 }
	shownAlerts = alertsLib.update(c)
	local overlays = panel.parts(c.protos, "overlay")
	local view = {}
	local next = 1
	for _, layer in LAYERS do
		while overlays[next] and overlays[next].at < layer.at do
			overlays[next].fn(c, view)
			next += 1
		end
		layer.fn(c, view)
	end
	for i = next, #overlays do
		overlays[i].fn(c, view)
	end
end

-- Сетка и сведения для выбранного — снаружи: так их сверяют, не рисуя.
hud.slots, hud.info = slots, info

return hud
