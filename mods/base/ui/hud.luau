--!strict
-- Панель игрока — перенос packages/client/src/gui/hud.ts (верхняя полоса) и gui/bar.ts (нижняя: мини-карта,
-- сведения о выбранном, сетка команд 4 × 3). Те же размеры, рамки скина, шрифты и цвета.

local widgets = require("lib/widgets")
local stats = require("lib/stats")
local conversion = require("lib/conversion")
local COLORS, shadow = widgets.COLORS, widgets.shadow

local hud = {}

-- Верхняя полоса и нижняя панель: высоты, ячейки, портреты — как в hud.ts и bar.ts.
local TOP_HEIGHT = 38
local INNER = 140
local CELL_WIDTH = 132
local GRID_WIDTH = 4 * CELL_WIDTH + 3 * 4
local BAR_SPACING = 16 + 8 + 8
local PORTRAIT = 96
local TILE = 32
local QUEUED = 24
-- Сторона мини-карты: из настроек игрока, но не больше, чем оставляет сведениям ширина экрана (minimapSide).
local settings = require("lib/settings")
local INFO_MIN = 104 + 10 + 24 + 150
local GRID_KEYS = { "T", "Y", "U", "I", "G", "H", "J", "K", "B", "N", "M", "," }
-- Постоянные места сетки: превращение и отмена (CONVERT, CANCEL в commands.ts).
local CONVERT, CANCEL = 9, 10
local KEY_NAMES = { "t", "y", "u", "i", "g", "h", "j", "k", "b", "n", "m", "," }

-- Свой игрок: кредиты.
local function credits(c): number
	for _, e in c:each({ "Player" }) do
		local player = c:get(e, "Player")
		if player.id == c.player then
			return player.credits
		end
	end
	return 0
end

local function topBar(c)
	local ui = c.ui
	ui:box({ id = "top", anchor = { left = 0, right = 0, top = 0 }, height = TOP_HEIGHT, skin = "panel", padding = { 4, 12 }, direction = "row", align = "center", gap = 12 }, function()
		ui:box({ id = "credits", direction = "row", align = "center", gap = 6 }, function()
			widgets.coin(ui)
			ui:text(tostring(math.floor(credits(c))), { font = "title", color = COLORS.gold, shadow = COLORS.ink, lift = 2 })
			local income = c.protos.mechanics.players.data.income
			if income > 0 then
				ui:text("+" .. income .. "/с", { color = COLORS.good })
			end
		end)
		ui:tip("credits", "Кредиты")
		ui:space(0, 0, 1)
		local hour = c.atmosphere.hour or 0
		ui:box({ id = "clock", direction = "row", gap = 4 }, function()
			ui:text(string.format("%02d:%02d", math.floor(hour), math.floor(hour * 60) % 60), { color = COLORS.dim })
		end)
		ui:tip("clock", "Время суток")
		if ui:button("menu", { padding = { 2, 10 }, height = 30 }, function()
			ui:text("Меню", shadow())
		end) then
			c.shared.paused = true
		end
		ui:tip("menu", "Меню игры")
	end)
end

-- Превращение выбранного (conversion в hud.ts): MCV разворачивается, главное здание сворачивается; nil — не то.
local function conversionOf(c, e: number)
	local kind = c:proto(e)
	local unit = c:has(e, "Unit")
	if not kind or kind.id ~= (if unit then conversion.unit(c) else conversion.building(c)).id then
		return nil
	end
	local converting = c:get(e, "Converting")
	local mode = c.shared.mode
	return {
		unit = unit,
		possible = if unit then conversion.canSend(c, c.player, e) else conversion.canPack(c, c.player, e),
		progress = if converting then 1 - converting.left / converting.total else nil,
		blocked = conversion.blocked(c, e),
		choosing = mode ~= nil and mode.kind == "deploying" and mode.unit == e,
		traveling = not converting and c:has(e, "Deploys"),
		cancel = unit and (converting ~= nil or c:has(e, "Deploys")),
	}
end

-- Ячейки сетки команд для выбранного: у своего завода — заказ юнитов, у MCV и главного здания — превращение.
local function slots(c, selection)
	local list = {}
	local state = #selection == 1 and c:mine(selection[1]) and conversionOf(c, selection[1])
	if state then
		local e = selection[1]
		-- MCV разворачивают как строят: кнопка включает выбор места, он доедет туда сам.
		if not state.progress then
			local building = conversion.building(c)
			list[CONVERT] = {
				label = if state.unit then "Развернуть" else "Свернуть в MCV",
				picture = building,
				about = if state.unit then building.data.info else nil,
				title = if state.unit then "Выбрать место: MCV доедет и развернётся там. Нужна свободная скала или фундамент 3×3" else nil,
				disabled = not state.possible,
				active = state.choosing,
				run = function()
					if not state.unit then
						c:send("pack", { building = e })
					elseif state.choosing then
						c.shared.mode = nil
					else
						c.shared.mode = { kind = "deploying", unit = e }
					end
				end,
			}
		end
		if (state.progress or state.traveling) and state.cancel then
			list[CANCEL] = {
				label = "Отменить",
				run = function()
					c:send("cancelDeploy", { unit = e })
				end,
			}
		end
	end
	if #selection == 1 and c:has(selection[1], "Producer") and c:mine(selection[1]) then
		local building = selection[1]
		local kind = c:proto(building)
		local money = credits(c)
		for _, name in kind.data.produces or {} do
			local unit = c.protos.units[name]
			if unit then
				table.insert(list, {
					label = unit.data.title or name,
					picture = unit,
					cost = unit.data.cost,
					short = money < unit.data.cost,
					about = unit.data.about,
					unit = unit,
					run = function()
						c:send("produce", { building = building, unit = name })
					end,
				})
			end
		end
	end
	return list
end

-- Карточка ячейки (slotCard в bar.ts): название с клавишей, пояснение, параметры юнита, цена.
local function card(ui, slot, hotkey: string)
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
			for _, row in stats.unit(slot.unit) do
				ui:box({ direction = "row", gap = 10 }, function()
					ui:box({ width = 90 }, function()
						ui:text(row.label, { color = COLORS.dim })
					end)
					ui:text(row.value)
				end)
			end
		end
		if slot.cost then
			ui:box({ direction = "row", align = "center", gap = 4 }, function()
				widgets.coin(ui)
				ui:text(tostring(slot.cost), { color = COLORS.gold })
			end)
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
					local click = ui:button(id, { width = cellWidth, height = cellHeight, padding = { 0, 6, 0, if slot.picture then 4 else 8 }, gap = 6, justify = "start", active = slot.active, disabled = slot.disabled }, function()
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
									ui:text(tostring(slot.cost), shadow({ color = if slot.short then COLORS.warn else COLORS.gold }))
								end
							end)
						end)
					end)
					-- Подсказка — карточкой над сеткой, правым краем у указателя.
					local grid = ui:rect("commands")
					ui:tip(id, function()
						card(ui, slot, hotkey)
					end, if grid then { right = math.max(8, c.screen.w - c.input.x - 40), bottom = c.screen.h - grid.y + 12 } else nil)
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
	local title = if kind and kind.data then kind.data.title or kind.name else "?"
	if many then
		local counts, order = {}, {}
		for _, e in selection do
			local k = c:proto(e)
			local name = k and k.data.title or "?"
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
			ui:tip("portrait", "Показать на карте")
		end
		ui:box({ id = "info:details", direction = "column", gap = 4, grow = 1, maxHeight = height - 20, scroll = true }, function()
			ui:box({ id = "info:title", width = text }, function()
				ui:text(title, { font = "title", color = COLORS.bright, shadow = COLORS.ink, lift = 2, ellipsis = true })
			end)
			-- Параметры юнита — строкой, целиком — в подсказке.
			local unitKind = if not many and c:has(first, "Unit") then kind else nil
			ui:tip("info:title", if many then title elseif unitKind then stats.text(unitKind) else "")
			if unitKind then
				ui:box({ id = "info:stats", width = text }, function()
					ui:text(stats.line(unitKind), { color = COLORS.dim, ellipsis = true })
				end)
				ui:tip("info:stats", stats.text(unitKind))
			end
			local state = not many and c:mine(first) and conversionOf(c, first)
			if state and state.progress then
				widgets.bar(ui, state.progress, if state.blocked then "Место занято юнитами" elseif state.unit then "Разворачивается" else "Сворачивается", text)
			end
			local producer = not many and c:get(first, "Producer")
			local packed = producer and c:has(first, "Unit")
			if producer then
				if producer.unit ~= "" then
					local unit = c.protos.units[producer.unit]
					widgets.bar(ui, producer.progress / (unit.data.buildTime or 1), unit.data.title or producer.unit, text)
					ui:box({ direction = "row", gap = 4 }, function()
						for i, name in { producer.unit, table.unpack(producer.queue) } do
							ui:box({ id = "queue:" .. i, width = 32, height = 32, skin = "well", padding = 4 }, function()
								ui:image(c.protos.units[name], QUEUED, QUEUED)
							end)
						end
					end)
				end
				if packed and producer.unit ~= "" then
					ui:text("База свёрнута: очередь стоит и продолжится, когда MCV развернётся", { color = COLORS.soft, wrap = text })
				end
				if not packed then
					ui:text(if producer.rally then "Готовые едут к флажку; правый щелчок по карте — перенести" else "Правый щелчок по карте — точка сбора готовых", { color = COLORS.soft, wrap = text })
				end
			end
			if state and state.unit and not state.progress and not state.choosing then
				ui:text(if state.traveling then "Едет к месту, чтобы развернуться" else "Передвижная база. Нажми «Развернуть» и выбери место на свободной скале или фундаменте 3×3 — лучше у месторождения: MCV доедет и станет главным зданием, которое заказывает строителей и задаёт зону стройки", { color = COLORS.soft, wrap = text })
			end
		end)
	end)
end

-- Ничего не выбрано: подсказка по управлению.
local function nothing(ui, width: number, height: number)
	ui:box({ width = width, height = height, skin = "well", padding = { 10, 12 }, direction = "column", justify = "center", gap = 4, clip = true }, function()
		for _, line in { "Ничего не выбрано.", "Левая кнопка — выбрать, рамка — несколько юнитов, правая — приказ." } do
			ui:text(line, { color = COLORS.muted, wrap = true })
		end
	end)
end

-- Мини-карта — как minimap.ts и minimapView в bar.ts: местность, здания и юниты цветом стороны, рамка экрана;
-- левая кнопка (и протяжка) ставит туда камеру, правая шлёт выделенных.
local SIDE_COLORS = { own = "#5aa9ff", foe = "#ff6b5a", neutral = "#c8c8c8" }

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
			-- Разведанные месторождения — цветом своего ресурса.
			for _, e in c:each({ "Deposit", "Position" }) do
				local p = c:get(e, "Position")
				local kind = c:proto(e)
				if c:explored(p.x, p.y) and kind and kind.data.color then
					local x, y = at(p.x, p.y)
					ui:box({ self = { "start", "start" }, padding = { math.floor(y - dot / 2), 0, 0, math.floor(x - dot / 2) } }, function()
						ui:box({ width = dot, height = dot, background = kind.data.color })
					end)
				end
			end
			for _, e in c:each({ "Owner", "Position" }) do
				local building = c:get(e, "Building")
				local p0 = c:get(e, "Position")
				if (building or c:has(e, "Unit")) and (c:mine(e) or c:sees(p0.x, p0.y)) then
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
	ui:box({ id = "bar", anchor = { left = 0, right = 0, bottom = 0 }, height = INNER + 16, skin = "panel", padding = { 4, 8 }, direction = "row", align = "end", gap = 8 }, function()
		ui:box({ height = INNER, direction = "column", justify = "end" }, function()
			minimapView(c, side)
		end)
		ui:box({ direction = "row", gap = 8, height = INNER, align = "center" }, function()
			if selected then
				info(c, selection, infoWidth, INNER)
			else
				nothing(ui, infoWidth, INNER)
			end
			commandGrid(c, if selected then slots(c, selection) else {}, GRID_WIDTH, INNER)
		end)
	end)
end

-- Режимы наведения: название и что делать (mode в hud.ts).
local MODES = {
	deploying = { name = "Разворачивание MCV", tip = "Щёлкни, где развернуть: на зелёном можно, MCV доедет сам" },
}

-- Полоса режима над полем (modeBar в hud.ts): какой режим, что делать дальше и как выйти. Esc и правая кнопка
-- работают и так, но на сенсорном экране их нет.
local function modeBar(c)
	local mode = c.shared.mode
	local spec = mode and MODES[mode.kind]
	if not spec then
		return
	end
	local ui = c.ui
	local room = ui.width - 24
	ui:box({ anchor = { centerX = 0, top = TOP_HEIGHT + 6 } }, function()
		ui:box({ id = "mode", skin = "panel", padding = { 10, 12, 10, 16 }, direction = "row", align = "center", gap = 12, maxWidth = room }, function()
			ui:text(spec.name, { color = COLORS.team })
			ui:text(spec.tip, { color = COLORS.soft, wrap = math.max(160, room - 320) })
			if ui:button("mode:cancel", { height = 32, padding = { 2, 14 } }, function()
				ui:text("Отмена", shadow())
			end) then
				c.shared.mode = nil
			end
			ui:tip("mode:cancel", "То же — правая кнопка мыши или Esc")
		end)
	end)
end

function hud.draw(c)
	modeBar(c)
	topBar(c)
	bottomBar(c)
end

return hud
