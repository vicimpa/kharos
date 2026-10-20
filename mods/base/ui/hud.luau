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

-- Верхняя полоса и нижняя панель: высоты, ячейки, портреты.
local TOP_HEIGHT = panel.TOP
local INNER = 140
local CELL_WIDTH = 132
local GRID_WIDTH = 4 * CELL_WIDTH + 3 * 4
local BAR_SPACING = 16 + 8 + 8
local PORTRAIT = 96
local TILE = 32
-- Сторона мини-карты: из настроек игрока, но не больше, чем оставляет сведениям ширина экрана.
local settings = require("lib/settings")
local INFO_MIN = 104 + 10 + 24 + 150
local GRID_KEYS = { "T", "Y", "U", "I", "G", "H", "J", "K", "B", "N", "M", "," }
-- С какой доли выработки полная нагрузка сети уже тесна: число энергии на полосе желтеет.
local GRID_TIGHT = 0.8

-- Пульс подсказки «Первых шагов»: обводка огнями команды разгорается и гаснет раз в секунду от low до high; восемь
-- ступеней — плавнее не разглядеть.
local function pulse(ui, low: number, high: number, color: string?, period: number?): string
	local phase = (ui.now / (period or 1)) % 1
	local level = math.round((low + (high - low) * (0.5 - 0.5 * math.cos(phase * math.pi * 2))) * 8) / 8
	return string.format("rgba(%s / %g)", color or "90 169 255", level)
end

local currentStep, number, goodWith, goodsRow = panel.currentStep, panel.number, panel.goodWith, panel.goodsRow
local KEY_NAMES = { "t", "y", "u", "i", "g", "h", "j", "k", "b", "n", "m", "," }

-- Сеть, которую показывает полоса: выбранного своего здания, а без него — первая (с главным зданием).
local function shownGrid(c)
	local zones = economy.zones(c, c.player)
	local index = 1
	for _, e in c.shared.selection or {} do
		if c:mine(e) then
			local found = economy.gridOf(c, e)
			if found then
				index = found
				break
			end
		end
	end
	local shown = zones[index]
	return if shown then panel.gridState(shown) else nil
end

local function topBar(c)
	local ui = c.ui
	ui:box({ id = "top", anchor = { left = 0, right = 0, top = 0 }, height = TOP_HEIGHT, skin = "panel", padding = { 4, 12 }, direction = "row", align = "center", gap = 12 }, function()
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
		local grid = shownGrid(c)
		if grid then
			local color = if grid.demand > grid.produced or grid.overload then COLORS.bad elseif grid.peak > grid.produced * GRID_TIGHT then COLORS.warn else COLORS.power
			ui:box({ id = "grid" }, function()
				ui:text("⚡ " .. number(grid.demand) .. " / " .. number(grid.produced), { color = color })
			end)
			ui:tip("grid", panel.gridText(c, grid) .. "\n" .. c:t("hud.gridTip"))
		end
		-- Запас в хранилищах.
		local items, capacity = logistics.stockOf(c, c.player)
		if capacity > 0 then
			ui:box({ id = "stock" }, function()
				goodsRow(c, items, c:t("hud.storesEmpty"))
			end)
			ui:tip("stock", c:t("hud.stockTip", { capacity = capacity }))
		end
		ui:space(0, 0, 1)
		local hour = c.atmosphere.hour or 0
		ui:box({ id = "clock", direction = "row", gap = 4 }, function()
			ui:text(string.format("%02d:%02d", math.floor(hour), math.floor(hour * 60) % 60), { color = COLORS.dim })
		end)
		ui:tip("clock", c:t("hud.clock"))
		-- Кнопка исследований: открывает дерево технологий, с процентом нынешней темы.
		local current = research.current(c, c.player)
		local state = research.player(c, c.player)
		-- Подсказка «Первых шагов»: следующий шаг — исследовать тему.
		local hint = (currentStep(c) or {}).research
		if ui:button("tech", { active = c.shared.techOpen == true, padding = { 2, 10 }, height = 30, outline = if hint then pulse(ui, 0.3, 1) else nil }, function()
			ui:text(c:t("grid.techTree"), shadow())
			if current and state then
				ui:text(math.round(((state.progress or {})[current] or 0) * 100) .. "%", shadow({ color = COLORS.team }))
			end
		end) then
			c.shared.techOpen = not c.shared.techOpen
		end
		ui:tip("tech", c:t("tech.openTip"))
		if ui:button("menu", { padding = { 2, 10 }, height = 30 }, function()
			ui:text(c:t("game.menu"), shadow())
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
	local WIDTH = 264
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

local function commandGrid(c, list, width: number, height: number)
	local ui = c.ui
	local cellWidth = (width - 3 * 4) / 4
	local cellHeight = (height - 2 * 4) / 3
	ui:box({ id = "commands", direction = "column", gap = 4, width = width, height = height }, function()
		for row = 0, 2 do
			ui:box({ direction = "row", gap = 4 }, function()
				for column = 0, 3 do
					local i = row * 4 + column + 1
					local slot = list[i]
					local hotkey = GRID_KEYS[i]
					if not slot then
						ui:box({ width = cellWidth, height = cellHeight, skin = "well", alpha = 0.35 })
						continue
					end
					local id = "cell:" .. i
					-- Подсказка шага — синим, новая кнопка — золотом.
					local outline = if slot.hint and not slot.disabled then pulse(ui, 0.3, 1) elseif slot.fresh and not slot.disabled then pulse(ui, 0.2, 0.95, "240 201 90", 1.6) else nil
					local click = ui:button(id, { width = cellWidth, height = cellHeight, padding = { 0, 6, 0, if slot.picture then 4 else 8 }, gap = 6, justify = "start", active = slot.active, disabled = slot.disabled, outline = outline }, function()
						if slot.picture then
							ui:box({ direction = "stack" }, function()
								ui:box({ width = TILE, height = TILE }, function()
									ui:image(slot.picture, TILE, TILE)
								end)
								ui:box({ self = { "start", "start" }, background = COLORS.ink, padding = { 0, 2 } }, function()
									widgets.key(ui, hotkey, if slot.disabled then COLORS.muted else COLORS.gold)
								end)
							end)
						end
						ui:box({ direction = "column", grow = 1, gap = 0, clip = true }, function()
							ui:box({ direction = "row", gap = 6 }, function()
								ui:box({ grow = 1 }, function()
									ui:text(slot.label, shadow({ color = COLORS.bright, ellipsis = true }))
								end)
								if not slot.picture then
									widgets.key(ui, hotkey, if slot.disabled then COLORS.muted else COLORS.gold)
								end
							end)
							ui:box({ direction = "row", align = "center", gap = 4 }, function()
								if slot.cost then
									widgets.coin(ui)
									ui:text(if slot.gain then "+" .. slot.cost else tostring(slot.cost), shadow({ color = if slot.gain then COLORS.good elseif slot.short then COLORS.warn else COLORS.gold }))
								elseif slot.count then
									ui:text(tostring(slot.count), shadow({ color = COLORS.dim }))
								end
							end)
						end)
						if slot.lamp ~= nil then
							ui:box({ width = 6, height = 6, background = if slot.lamp then COLORS.good else COLORS.bad })
						end
					end)
					-- Подсказка — карточкой над сеткой, правым краем у указателя.
					local grid = ui:rect("commands")
					ui:tip(id, function()
						card(ui, c, slot, hotkey)
					end, if grid then { right = math.max(8, c.screen.w - c.input.x - 40), bottom = c.screen.h - grid.y + 12 } else nil)
					-- Пока смотрят кнопку здания, на карте видны границы зон (controls/build).
					if slot.zones and ui:hovered(id) then
						c.shared.zonesHover = true
					end
					-- Навели на новую кнопку — она знакома.
					if slot.fresh and slot.seen and ui:hovered(id) then
						seenLib.mark(c, slot.seen)
					end
					if click or (c.input.hits[KEY_NAMES[i]] and not c.input.keys.ctrl and not slot.disabled) then
						slot.run()
					end
				end
			end)
		end
	end)
end

-- Сведения о выбранном: портрет (или плитки отряда), название и что оно делает.
local function info(c, selection, width: number, height: number)
	local ui = c.ui
	local many = #selection > 1
	local first = selection[1]
	local kind = c:proto(first)
	local title = if kind and kind.data then c:t(kind.data.title) or kind.name else "?"
	local site = not many and c:get(first, "Site")
	if site then
		title = c:t(if site.undo then "hud.undoing" elseif site.demolish then "hud.demolition" else "hud.construction", { name = title })
	end
	if many then
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
		title = table.concat(parts, ", ")
	end
	local columns = math.max(1, math.min(4, math.floor((width - 24 - 10 - 150 + 4) / 44)))
	local left = if many then columns * 40 + (columns - 1) * 4 else 104
	local text = math.max(40, width - 24 - left - 10)
	ui:box({ width = width, height = height, skin = "well", padding = { 10, 12 }, direction = "row", gap = 10 }, function()
		if many then
			ui:box({ direction = "column", gap = 4, width = left, maxHeight = height - 20, scroll = true, id = "info:units" }, function()
				for start = 1, #selection, columns do
					ui:box({ direction = "row", gap = 4 }, function()
						for index = start, math.min(#selection, start + columns - 1) do
							local e = selection[index]
							ui:button("unit:" .. index, { width = 40, height = 40, padding = 0, skin = "well", direction = "stack" }, function()
								ui:box({ self = { "center", "center" } }, function()
									ui:image(c:proto(e), TILE, TILE)
								end)
							end)
						end
					end)
				end
			end)
		else
			ui:button("portrait", { width = 104, height = 104, padding = 0, skin = "well", direction = "stack" }, function()
				ui:box({ self = { "center", "center" } }, function()
					ui:image(kind, PORTRAIT, PORTRAIT)
				end)
				ui:box({ self = { "start", "end" }, width = 104, height = 6, background = "#4fd07a" })
			end)
			ui:tip("portrait", c:t("hud.showOnMap"))
		end
		ui:box({ id = "info:details", direction = "column", gap = 4, grow = 1, maxHeight = height - 20, scroll = true }, function()
			ui:box({ id = "info:title", width = text }, function()
				ui:text(title, { font = "title", color = COLORS.bright, shadow = COLORS.ink, lift = 2, ellipsis = true })
			end)
			-- Параметры юнита — строкой, целиком — в подсказке.
			local unitKind = if not many and c:has(first, "Unit") then kind else nil
			ui:tip("info:title", if many then title elseif unitKind then stats.text(c, unitKind) else "")
			if unitKind then
				ui:box({ id = "info:stats", width = text }, function()
					ui:text(stats.line(c, unitKind), { color = COLORS.dim, ellipsis = true })
				end)
				ui:tip("info:stats", stats.text(c, unitKind))
			end
			-- Дальше — куски панели механик (lib/panel): склад, энергия, работа, очередь.
			local view = { selection = selection, first = first, kind = kind, many = many, site = site, width = text }
			view.built = not many and not site and kind and c:has(first, "Building")
			for _, part in panel.parts(c.protos, "info") do
				part.fn(c, view)
			end
		end)
	end)
end

-- Ничего не выбрано: подсказка по управлению.
local function nothing(c, width: number, height: number)
	local ui = c.ui
	ui:box({ width = width, height = height, skin = "well", padding = { 10, 12 }, direction = "column", justify = "center", gap = 4, clip = true }, function()
		-- По предложению в строке.
		local rest = c:t("hud.nothingSelected")
		while rest ~= "" do
			local stop, after = string.find(rest, "%.%s+")
			ui:text(if stop then string.sub(rest, 1, stop) else rest, { color = COLORS.muted, wrap = true })
			rest = if after then string.sub(rest, after + 1) else ""
		end
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

local function bottomBar(c)
	local ui = c.ui
	local selection = c.shared.selection or {}
	local selected = #selection > 0
	local side = math.max(INNER, math.min(settings.prefs(c).minimap, ui.width - BAR_SPACING - GRID_WIDTH - INFO_MIN))
	local infoWidth = ui.width - BAR_SPACING - side - GRID_WIDTH
	-- Мини-карта выше панели: что стоит над панелью слева (чат), встаёт над ней.
	c.shared.inset.minimap = side + 8
	ui:box({ id = "bar", anchor = { left = 0, right = 0, bottom = 0 }, height = INNER + 16, skin = "panel", padding = { 4, 8 }, direction = "row", align = "end", gap = 8 }, function()
		ui:box({ height = INNER, direction = "column", justify = "end" }, function()
			minimapView(c, side)
		end)
		ui:box({ direction = "row", gap = 8, height = INNER, align = "center" }, function()
			if selected then
				info(c, selection, infoWidth, INNER)
			else
				nothing(c, infoWidth, INNER)
			end
			commandGrid(c, if selected then slots(c, selection) else {}, GRID_WIDTH, INNER)
		end)
	end)
end

-- Ширина экрана, ниже которой список шагов сжимается до текущего.
local NARROW = 1000

-- Виден ли список «Первых шагов»: не скрыт в настройках и не пройден ещё до входа в мир.
local function stepsShown(c): boolean
	if settings.prefs(c).steps == "off" then
		return false
	end
	local done = stepsLib.of(c).done
	local finished = table.find(done, false) == nil
	if c.shared.stepsKnown == nil then
		c.shared.stepsKnown = finished
	end
	return not (finished and c.shared.stepsKnown)
end

-- Первые шаги новичка в углу: список с галочками, у текущего — что сделать и зачем. Заголовок сворачивает список,
-- крестик прячет совсем (вернуть — в настройках). Мир, где всё уже пройдено при входе, списка не показывает.
local function stepsPanel(c)
	if not stepsShown(c) then
		return
	end
	local ui = c.ui
	local state = stepsLib.of(c)
	local done, target = state.done, state.target
	local shown = settings.prefs(c).steps
	local current = table.find(done, false)
	local count = 0
	for _, passed in done do
		if passed then
			count += 1
		end
	end
	local width = math.min(300, ui.width - 24)
	ui:box({ anchor = { right = 12, top = TOP_HEIGHT + 6 }, width = width, skin = "panel", padding = { 8, 10, 10, 10 }, direction = "column", align = "stretch", gap = 6 }, function()
		ui:box({ direction = "row", gap = 4 }, function()
			if ui:button("steps:toggle", { height = 28, padding = { 0, 8 }, justify = "start" }, function()
				ui:text(c:t("steps.title"), shadow())
				ui:text(count .. "/" .. #stepsLib.LIST, shadow({ font = "small", color = COLORS.gold }))
				ui:text(if shown == "open" then "▾" else "▸", shadow({ font = "small" }))
			end) then
				settings.setPref(c, "steps", if shown == "open" then "folded" else "open")
			end
			ui:tip("steps:toggle", if shown == "open" then c:t("steps.foldTip") else c:t("steps.unfoldTip"))
			if ui:button("steps:close", { height = 28, padding = { 0, 8 } }, function()
				ui:text("×", shadow())
			end) then
				settings.setPref(c, "steps", "off")
			end
			ui:tip("steps:close", c:t("steps.closeTip"))
		end)
		if shown ~= "open" then
			return
		end
		if not current then
			ui:box({ padding = { 0, 2 } }, function()
				ui:text(c:t("steps.finished"), { color = COLORS.good, wrap = width - 24 })
			end)
			return
		end
		local narrow = ui.width < NARROW
		-- Список — плотнее панели: строки через 4, описание текущего шага — мелким шрифтом.
		ui:box({ direction = "column", align = "stretch", gap = 4, padding = { 0, 2 } }, function()
			for i, step in stepsLib.LIST do
				-- На узком экране — только текущий шаг: список закрыл бы поле.
				if narrow and i ~= current then
					continue
				end
				local color = if done[i] then COLORS.dim elseif i == current then COLORS.bright else COLORS.muted
				ui:box({ direction = "row", gap = 8 }, function()
					ui:box({ width = 14, direction = "row", justify = "end" }, function()
						ui:text(if done[i] then "✓" else tostring(i), { color = if done[i] then COLORS.good elseif i == current then COLORS.team else color })
					end)
					ui:box({ direction = "column", gap = 2, grow = 1 }, function()
						ui:text(c:t(step.title), { color = color, wrap = width - 46 })
						if i ~= current then
							return
						end
						ui:text(c:t(step.tip), { font = "small", color = COLORS.soft, wrap = width - 46 })
						if target then
							ui:space(0, 2)
							if ui:button("steps:show", { height = 28, padding = { 0, 10 } }, function()
								ui:text(c:t("steps.show"), shadow())
							end) then
								c.shared.flyTo = { x = target.x + target.width / 2, y = target.y + target.height / 2 }
							end
							ui:tip("steps:show", c:t("steps.showTip"))
						end
					end)
				end)
			end
		end)
	end)
end

-- Полоса режима над полем: какой режим, что делать дальше и как выйти. Esc и правая кнопка работают и так, но на
-- сенсорном экране их нет.
local function modeBar(c)
	local mode = c.shared.mode
	local spec = mode and panel.mode(c.protos, mode.kind)
	if not spec then
		return
	end
	local ui = c.ui
	-- Справа — «Первые шаги», слева — уведомления: середина не наезжает на них.
	local room = if stepsShown(c) and ui.width >= NARROW then math.min(ui.width - 24, math.max(280, ui.width - 2 * 324)) else ui.width - 24
	ui:box({ anchor = { centerX = 0, top = TOP_HEIGHT + 6 } }, function()
		ui:box({ id = "mode", skin = "panel", padding = { 10, 12, 10, 16 }, direction = "row", align = "center", gap = 12, maxWidth = room }, function()
			local name, tip = spec.describe(c, mode)
			ui:text(name, { color = COLORS.team })
			ui:text(tip, { color = COLORS.soft, wrap = math.max(160, room - 320) })
			if spec.done then
				if ui:button("mode:done", { height = 32, padding = { 2, 14 }, skin = "button-primary" }, function()
					ui:text(c:t("mode.done"), shadow())
				end) then
					spec.done(c)
				end
				ui:tip("mode:done", c:t("mode.doneTip"))
			end
			if ui:button("mode:cancel", { height = 32, padding = { 2, 14 } }, function()
				ui:text(c:t("mode.cancel"), shadow())
			end) then
				c.shared.mode = nil
			end
			ui:tip("mode:cancel", c:t("mode.endTip"))
		end)
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
	local mode = ui:rect("mode")
	local top = TOP_HEIGHT + 6 + (if mode and c.shared.mode then mode.height + 6 else 0)
	ui:box({ anchor = { centerX = 0, top = top }, direction = "column", align = "center", gap = 6 }, function()
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
		for i, toast in learned do
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

-- Уведомления слева под полосой: строка цвета вида с маркером; щелчок ведёт камеру к месту. Со временем гаснут.
local ALERT_COLORS = { attacked = COLORS.bad, spotted = COLORS.warn, found = COLORS.good, ping = COLORS.ally }
local function alertList(c)
	local list = shownAlerts
	if #list == 0 then
		return
	end
	local ui = c.ui
	local seconds = alertsLib.data.seconds
	ui:box({ anchor = { left = 12, top = TOP_HEIGHT + 6 }, skin = "panel", padding = { 10, 12 }, direction = "column", gap = 4 }, function()
		for _, alert in list do
			local age = alertsLib.age(alert)
			local bright = seconds * 0.75
			local fade = if age < bright then 1 else math.max(0.25, 1 - 0.75 * (age - bright) / (seconds - bright))
			local id = "alert:" .. alert.at
			local color = ALERT_COLORS[alert.kind] or COLORS.text
			ui:box({ id = id, direction = "row", align = "center", gap = 8, padding = { 2, 4 }, alpha = math.round(fade * 8) / 8 }, function()
				ui:box({ width = 6, height = 6, background = color })
				ui:text(c:t(alertsLib.TEXTS[alert.text] or alert.text), { color = color, shadow = COLORS.ink })
			end)
			ui:tip(id, c:t("hud.showPlace"))
			if ui:clicked(id) then
				c.shared.flyTo = { x = alert.x, y = alert.y }
			end
		end
	end)
end

-- Части самой панели по местам (lib/panel.LAYERS); между ними — куски механик поверх поля.
local LAYERS = {
	{ at = panel.LAYERS.alerts, fn = function(c)
		alertList(c)
	end },
	{ at = panel.LAYERS.steps, fn = stepsPanel },
	{ at = panel.LAYERS.mode, fn = modeBar },
	{ at = panel.LAYERS.rewards, fn = rewards },
	{ at = panel.LAYERS.top, fn = topBar },
	{ at = panel.LAYERS.bottom, fn = bottomBar },
}

function hud.draw(c)
	-- Видимая часть карты — между верхней полосой и нижней панелью (inset камеры): у её краёв едет камера за рамкой.
	c.shared.inset = { top = TOP_HEIGHT, bottom = INNER + 16, left = 0, right = 0 }
	shownAlerts = alertsLib.update(c)
	local overlays = panel.parts(c.protos, "overlay")
	local view = {}
	local next = 1
	for _, layer in LAYERS do
		while overlays[next] and overlays[next].at < layer.at do
			overlays[next].fn(c, view)
			next += 1
		end
		layer.fn(c)
	end
	for i = next, #overlays do
		overlays[i].fn(c, view)
	end
end

-- Сетка и сведения для выбранного — снаружи: так их сверяют, не рисуя.
hud.slots, hud.info = slots, info

return hud
