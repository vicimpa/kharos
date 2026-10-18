--!strict
-- Панель редактора — перенос editorPanel.ts и gui/screens/editor.ts: режим бога над миром. Кистью правится карта,
-- ставятся и сносятся здания, юниты и месторождения любого игрока, у выбранного — владелец, прочность, поворот, склад,
-- у игрока — кредиты и камера в начале игры. Каждая правка — приказ edit (mechanics/editor), мышь — controls/editor.
-- Внизу — «Выйти» (с несохранённым — дважды) и «Сохранить» в слот.

local editor = require("lib/editor")
local form = require("lib/form")
local goods = require("lib/goods")
local kinds = require("lib/kinds")
local tactics = require("lib/tactics")
local widgets = require("lib/widgets")
local controls = require("controls/editor")

local COLORS = widgets.COLORS

local panel = {}

-- Ширина панели и её содержимого (EDITOR_WIDTH, INNER).
local WIDTH = 300
local INNER = WIDTH - 24
local DEGREE = math.pi / 180

local TOOLS = { { "select", "editor.tools.select" }, { "paint", "editor.tools.paint" }, { "building", "editor.tools.building" }, { "unit", "editor.tools.unit" }, { "deposit", "editor.tools.deposit" } }
-- Варианты кисти; -1 — «как есть».
local KEEP = -1
local TERRAINS = { { KEEP, "common.asIs" }, { 2, "editor.terrains.rock" }, { 1, "editor.terrains.sand" }, { 0, "editor.terrains.swamp" }, { 3, "editor.terrains.mountain" } }
local DUNES = { { KEEP, "common.asIs" }, { 0, "editor.dunes.natural" }, { 1, "editor.dunes.none" }, { 2, "editor.dunes.many" } }
local BIOMES = { { KEEP, "common.asIs" }, { 0, "editor.biomes.erg" }, { 1, "editor.biomes.saltFlats" }, { 2, "editor.biomes.redWastes" }, { 3, "editor.biomes.marsh" } }
local SHAPES = { { "square", "editor.shapes.square" }, { "circle", "editor.shapes.circle" }, { "spray", "editor.shapes.spray" } }
local TIERS = { { KEEP, "common.asIs" }, { 0, "0" }, { 1, "1" }, { 2, "2" }, { 3, "3" } }
local CLIFFS = { { KEEP, "common.asIs" }, { 1, "editor.cliff" }, { 0, "editor.gentle" } }
local STANCE_LABELS = { aggressive = "grid.stances.aggressive", defensive = "grid.stances.defensive", hold = "grid.stances.hold", passive = "grid.stances.passive" }

-- Выйти нажато один раз с несохранённым: второе нажатие подтверждает.
local leaving = false

-- Варианты на языке игрока: подписи в списках выше — ключи словаря (lang).
local function translated(c, options)
	local list = {}
	for _, option in options do
		table.insert(list, { option[1], c:t(option[2]) })
	end
	return list
end

-- Название значения из вариантов; нет — прочерк.
local function nameIn(c, options, value): string
	for _, option in options do
		if option[1] == value then
			return c:t(option[2])
		end
	end
	return "—"
end

-- Значение кисти: KEEP — nil.
local function kept(value)
	return if value == KEEP then nil else value
end

local function choice(c, id: string, title: string, options, value)
	local ui = c.ui
	ui:text(title, { color = COLORS.dim })
	return form.chips(ui, id, translated(c, options), value, INNER, { small = true })
end

-- Подпись сущности.
local function nameOf(c, e: number): string
	local kind = kinds.of(c, e)
	return if kind and c:t(kind.data.title) then c:t(kind.data.title) else "#" .. e
end

-- Название приказа очереди: editor.orders по имени команды; точечный приказ — «ехать» (orderName).
local function orderName(c, name: string): string
	local key = "editor.orders." .. (if name == "order" then "move" else name)
	local text = c:t(key)
	return if text == key then name else text
end

-- Что делает юнит сейчас и что у него в очереди: строки для панели (tasksOf).
local function tasksOf(c, e: number): { string }
	local tasks = {}
	if c:has(e, "Converting") then
		table.insert(tasks, if c:has(e, "Mover") then c:t("editor.task.deploying") else c:t("editor.task.packing"))
	end
	local producer = c:get(e, "Producer")
	if producer and producer.unit ~= "" then
		local names = {}
		for _, name in { producer.unit, table.unpack(producer.queue) } do
			local kind = c.protos.units[name]
			table.insert(names, if kind then c:t(kind.data.title) else name)
		end
		table.insert(tasks, c:t("editor.task.produces", { list = table.concat(names, ", ") }))
	end
	local builds = c:get(e, "Builds")
	if builds and c:alive(builds.site) then
		table.insert(tasks, c:t(if c:has(builds.site, "Site") then "editor.task.builds" else "editor.task.repairs", { name = nameOf(c, builds.site) }))
	end
	local armed = c:get(e, "Armed")
	if armed and armed.target >= 0 and c:alive(armed.target) then
		table.insert(tasks, c:t("editor.task.attacks", { name = nameOf(c, armed.target) }))
	end
	local hauler = c:get(e, "Hauler")
	if hauler then
		if hauler.mine >= 0 then
			table.insert(tasks, c:t("editor.task.haulsFrom", { mine = hauler.mine }))
		end
		if #hauler.route > 0 then
			local names = {}
			for _, stop in hauler.route do
				table.insert(names, nameOf(c, stop))
			end
			table.insert(tasks, c:t("editor.task.route", { stops = table.concat(names, " → ") }))
		end
		if hauler.supply >= 0 then
			table.insert(tasks, c:t("editor.task.supplies", { name = nameOf(c, hauler.supply) }))
		end
		if hauler.pickup >= 0 then
			table.insert(tasks, c:t("editor.task.pickup"))
		end
		if #hauler.serve > 0 then
			local names = {}
			for _, building in hauler.serve do
				table.insert(names, nameOf(c, building))
			end
			table.insert(tasks, c:t("editor.task.serves", { list = table.concat(names, ", ") }))
		end
		if hauler.from >= 0 then
			local good = c.protos.goods[hauler.resource]
			table.insert(tasks, c:t("editor.task.carries", { good = if good then c:t(good.data.title) else hauler.resource, from = nameOf(c, hauler.from), to = if hauler.to >= 0 then nameOf(c, hauler.to) else "?" }))
		end
	end
	local state = c:get(e, "Tactics")
	if state and #state.patrol > 0 then
		table.insert(tasks, c:t("editor.task.patrol", { points = #state.patrol // 2 }))
	end
	local path = c:get(e, "Path")
	if path then
		table.insert(tasks, c:t("editor.task.goes", { x = math.floor(path.goalX), y = math.floor(path.goalY) }))
	end
	local orders = c:get(e, "Orders")
	for _, order in (if orders then orders.list else {}) do
		table.insert(tasks, c:t("editor.task.queued", { what = orderName(c, order.name) }))
	end
	return tasks
end

-- Выбранное: владелец, прочность, поворот, задания, склад (inspector). Выбрано несколько — правится каждое.
local function inspector(c, entities: { number })
	local ui = c.ui
	local first = entities[1]
	local health = c:get(first, "Health")
	local stock = c:get(first, "Inventory")
	local owner = c:get(first, "Owner")
	local players = { { 0, "0" } }
	for _, id in editor.players(c) do
		table.insert(players, { id, tostring(id) })
	end
	local units = {}
	for _, e in entities do
		if c:has(e, "Mover") then
			table.insert(units, e)
		end
	end
	local facing = units[1] and c:get(units[1], "Facing")
	local turrets = if #entities == 1 then editor.turretFacings(c, first) else {}
	local edit = function(op)
		controls.edit(c, op)
	end
	local function angleSlider(id: string, title: string, angle: number, apply: (number) -> ())
		ui:text(title, { color = COLORS.dim })
		local degrees = math.round(((angle / DEGREE + 180) % 360) - 180)
		local nextDegrees = form.slider(ui, id, degrees, { min = -180, max = 180, step = 15, width = INNER })
		if nextDegrees ~= degrees then
			apply(nextDegrees * DEGREE)
		end
	end
	ui:box({ direction = "column", gap = 6 }, function()
		ui:text(nameOf(c, first) .. (if #entities > 1 then c:t("editor.andMore", { count = #entities - 1 }) else ""), { color = COLORS.dim })
		local picked = choice(c, "editor:owner", c:t("editor.owner"), players, if owner then owner.player else 0)
		if picked ~= nil then
			edit({ op = "owner", entities = entities, player = picked })
		end
		if health then
			local share = math.round(health.value / health.max * 100)
			ui:text(c:t("editor.health", { percent = share }), { color = COLORS.dim })
			local nextShare = form.slider(ui, "editor:health", share, { min = 1, max = 100, step = 1, width = INNER })
			if nextShare ~= share then
				edit({ op = "health", entities = entities, share = nextShare / 100 })
			end
		end
		if facing then
			angleSlider("editor:hull", c:t("editor.hull", { degrees = math.round(facing.angle / DEGREE) }), facing.angle, function(angle)
				edit({ op = "facing", entities = entities, angle = angle })
			end)
		end
		for index, angle in turrets do
			local degrees = math.round(angle / DEGREE)
			local title = if #turrets > 1 then c:t("editor.turretOf", { index = index, degrees = degrees }) else c:t("editor.turret", { degrees = degrees })
			angleSlider("editor:turret:" .. index, title, angle, function(nextAngle)
				edit({ op = "turret", entities = entities, angle = nextAngle, index = index - 1 })
			end)
		end
		if #units > 0 then
			ui:text(c:t("editor.tasks"), { color = COLORS.dim })
			if #entities == 1 then
				local tasks = tasksOf(c, first)
				if #tasks > 0 then
					for _, task in tasks do
						ui:text(task, { wrap = INNER })
					end
				else
					ui:text(c:t("editor.idle"), { color = COLORS.dim })
				end
			end
			local state = c:get(first, "Tactics")
			if state then
				local options = {}
				for _, name in tactics.stances do
					table.insert(options, { name, c:t(STANCE_LABELS[name]) })
				end
				local stance = form.chips(ui, "editor:stance", options, state.stance, INNER, { small = true })
				if stance then
					for _, e in entities do
						local who = c:get(e, "Owner")
						edit({ op = "order", player = if who then who.player else 0, command = { type = "stance", units = { e }, stance = stance } })
					end
				end
			end
			local editorState = controls.state(c)
			ui:box({ direction = "row", gap = 2 }, function()
				if form.button(ui, "editor:ordering", c:t("editor.mouseOrder"), { active = editorState.ordering, height = 24, padding = { 2, 6 }, tip = c:t("editor.mouseOrderTip") }) then
					editorState.ordering = not editorState.ordering
				end
				if form.button(ui, "editor:clear", c:t("editor.clearTasks"), { height = 24, padding = { 2, 6 } }) then
					edit({ op = "clearTasks", entities = entities })
				end
			end)
		end
		if stock and #entities == 1 then
			ui:text(c:t("editor.stock", { capacity = stock.capacity }), { color = COLORS.dim })
			for _, name in goods.names(c) do
				ui:box({ direction = "row", align = "center", justify = "between", width = INNER }, function()
					ui:text(c:t(c.protos.goods[name].data.title))
					local amount = form.numberField(ui, "editor:stock:" .. name, math.floor(stock.items[name] or 0), { width = 90, min = 0, live = true })
					if amount then
						edit({ op = "stock", entity = first, good = name, amount = amount })
					end
				end)
			end
		end
	end)
end

local function slotName(c): string
	for _, slot in c.app:saves() do
		if slot.id == c.app.slot then
			return slot.name
		end
	end
	return ""
end

function panel.draw(c)
	local ui = c.ui
	local state = controls.state(c)
	local players = editor.players(c)
	local selected = controls.selection(c)
	local spots = controls.spots(c)
	local input = c.input
	local hover = if input.inside then { x = math.floor(input.wx), y = math.floor(input.wy) } else nil
	local tile = hover and editor.describeTile(c, hover.x, hover.y)
	local status = c.shared.editorStatus
	local dirty = c.shared.editorDirty == true
	local function edit(op)
		controls.edit(c, op)
	end
	ui:box({ id = "editor", anchor = { right = 8, top = 8, bottom = 8 }, width = math.min(WIDTH, ui.width - 32), skin = "panel", padding = 12, direction = "column", gap = 10, align = "stretch" }, function()
		ui:box({ direction = "row", justify = "between", gap = 8 }, function()
			ui:text(c:t("editor.title"), { font = "title", color = COLORS.bright })
			ui:box({ grow = 1, direction = "row", justify = "end" }, function()
				ui:text(slotName(c) .. (if c.shared.editorSaved then " · " .. c:t("editor.savedToSlot") else ""), { color = COLORS.dim, ellipsis = true })
			end)
		end)
		ui:box({ id = "editor:body", grow = 1, scroll = true, direction = "column", gap = 10, align = "stretch" }, function()
			-- Игрок: номер, новый игрок, его камера и кредиты.
			ui:box({ direction = "column", gap = 6 }, function()
				ui:text(c:t("editor.player"), { color = COLORS.dim })
				local options = { { 0, "0" } }
				local tips = { c:t("editor.nobodyTip") }
				for _, id in players do
					table.insert(options, { id, tostring(id) })
					table.insert(tips, false)
				end
				table.insert(options, { KEEP, "+" })
				table.insert(tips, c:t("editor.newPlayer"))
				local picked = form.chips(ui, "editor:player", options, state.player, INNER, { small = true, tips = tips })
				if picked == KEEP then
					edit({ op = "addPlayer" })
					state.player = (players[#players] or 0) + 1
				elseif picked ~= nil then
					state.player = picked
				end
				if state.player > 0 then
					local camera = editor.camera(c, state.player)
					ui:box({ direction = "row", gap = 2 }, function()
						if form.button(ui, "editor:camera", if camera then c:t("editor.cameraHere") else c:t("editor.setCamera"), { height = 24, padding = { 2, 6 }, tip = c:t("editor.cameraTip") }) then
							edit({ op = "camera", player = state.player, camera = { x = c.camera.x, y = c.camera.y, zoom = c.camera.zoom } })
						end
						if camera then
							if form.button(ui, "editor:toCamera", c:t("editor.toCamera"), { height = 24, padding = { 2, 6 } }) then
								c.shared.flyTo = { x = camera.x, y = camera.y }
							end
							if form.button(ui, "editor:dropCamera", c:t("editor.dropCamera"), { height = 24, padding = { 2, 6 } }) then
								edit({ op = "camera", player = state.player })
							end
						end
					end)
					ui:box({ direction = "row", align = "center", justify = "between", width = INNER }, function()
						ui:text(c:t("common.credits"))
						local credits = 0
						for _, e in c:each({ "Player" }) do
							local player = c:get(e, "Player")
							if player.id == state.player then
								credits = player.credits
							end
						end
						local amount = form.numberField(ui, "editor:credits", credits, { width = 90, min = 0, live = true })
						if amount then
							edit({ op = "credits", player = state.player, amount = amount })
						end
					end)
				end
			end)
			-- Инструменты и их настройки.
			ui:box({ direction = "column", gap = 6 }, function()
				local tool = form.chips(ui, "editor:tool", translated(c, TOOLS), state.tool, INNER, { small = true })
				if tool then
					state.tool = tool
				end
				if state.tool == "paint" then
					local brush = state.brush
					local terrain = choice(c, "editor:terrain", c:t("editor.ground"), TERRAINS, if brush.terrain == nil then KEEP else brush.terrain)
					if terrain ~= nil then
						brush.terrain = kept(terrain)
					end
					local biome = choice(c, "editor:biome", c:t("editor.biome"), BIOMES, if brush.biome == nil then KEEP else brush.biome)
					if biome ~= nil then
						brush.biome = kept(biome)
					end
					local tier = choice(c, "editor:tier", c:t("editor.tier"), TIERS, if brush.tier == nil then KEEP else brush.tier)
					if tier ~= nil then
						brush.tier = kept(tier)
					end
					local cliff = choice(c, "editor:cliff", c:t("editor.edge"), CLIFFS, if brush.cliff == nil then KEEP elseif brush.cliff then 1 else 0)
					if cliff ~= nil then
						brush.cliff = if cliff == KEEP then nil else cliff == 1
					end
					local dunes = choice(c, "editor:dunes", c:t("editor.dunesOnSand"), DUNES, if brush.dunes == nil then KEEP else brush.dunes)
					if dunes ~= nil then
						brush.dunes = kept(dunes)
					end
					local shape = choice(c, "editor:shape", c:t("editor.shape"), SHAPES, brush.shape or "square")
					if shape ~= nil then
						brush.shape = shape
					end
					ui:text(c:t("editor.brush", { size = state.size }), { color = COLORS.dim })
					state.size = form.slider(ui, "editor:size", state.size, { min = 1, max = 15, step = 2, width = INNER })
					ui:text(c:t("editor.paintNote", { tiles = math.round(editor.MAX_PEAK_RADIUS * 2) }) .. c:t("editor.paintNoteLocal"), { color = COLORS.dim, wrap = INNER })
				end
				if state.tool == "building" or state.tool == "unit" then
					local list = {}
					local section = if state.tool == "building" then c.protos.buildings else c.protos.units
					for name, kind in section do
						table.insert(list, { name, c:t(kind.data.title) or name })
					end
					table.sort(list, function(a, b)
						return a[2] < b[2]
					end)
					local current = if state.tool == "building" then state.building else state.unit
					local half = (INNER - 2) / 2
					ui:box({ id = "editor:list", direction = "column", gap = 2, maxHeight = math.round(ui.height * 0.4), scroll = true }, function()
						for i = 1, #list, 2 do
							ui:box({ direction = "row", gap = 2 }, function()
								for j = i, math.min(i + 1, #list) do
									local item = list[j]
									if form.button(ui, "editor:item:" .. item[1], item[2], { active = item[1] == current, width = half, height = 26, padding = { 2, 6 } }) then
										if state.tool == "building" then
											state.building = item[1]
										else
											state.unit = item[1]
										end
									end
								end
							end)
						end
					end)
				end
				if state.tool == "deposit" then
					local options = {}
					for name, kind in c.protos.deposits do
						table.insert(options, { name, c:t(kind.data.title) })
					end
					table.sort(options, function(a, b)
						return a[2] < b[2]
					end)
					local kind = choice(c, "editor:kind", c:t("editor.newDeposit"), options, state.kind)
					if kind then
						state.kind = kind
						state.reserve = c.protos.deposits[kind].data.max
					end
					ui:box({ direction = "row", align = "center", justify = "between", width = INNER }, function()
						ui:text(c:t("editor.reserve"))
						local reserve = form.numberField(ui, "editor:reserve", state.reserve, { width = 90, min = 0, live = true })
						if reserve then
							state.reserve = reserve
						end
					end)
					ui:text(c:t("editor.depositNote"), { color = COLORS.dim, wrap = INNER })
				end
				if state.tool == "select" then
					ui:text(c:t("editor.selectNote"), { color = COLORS.dim, wrap = INNER })
				end
			end)
			if state.tool == "select" and #spots > 0 then
				ui:box({ direction = "column", gap = 6 }, function()
					local first = spots[1]
					ui:text(if #spots == 1 then c:t(c.protos.deposits[first.kind].data.title) .. " · " .. first.x .. ", " .. first.y else c:t("editor.deposits", { count = #spots }), { color = COLORS.dim })
					local same = first.kind
					for _, spot in spots do
						if spot.kind ~= first.kind then
							same = nil
						end
					end
					local options = {}
					for name, kind in c.protos.deposits do
						table.insert(options, { name, c:t(kind.data.title) })
					end
					table.sort(options, function(a, b)
						return a[2] < b[2]
					end)
					local list = {}
					for _, spot in spots do
						table.insert(list, { x = spot.x, y = spot.y })
					end
					local kind = choice(c, "editor:spotKind", c:t("editor.kind"), options, same)
					if kind then
						edit({ op = "setDeposit", spots = list, kind = kind })
					end
					ui:box({ direction = "row", align = "center", justify = "between", width = INNER }, function()
						ui:text(if #spots > 1 then c:t("editor.leftEach") else c:t("editor.left"))
						local left = form.numberField(ui, "editor:left", math.floor(first.left), { width = 90, min = 0, live = true })
						if left then
							edit({ op = "setDeposit", spots = list, left = left })
						end
					end)
				end)
			end
			if state.tool == "select" and #selected > 0 then
				inspector(c, selected)
			end
			if state.tool == "select" and (#selected > 0 or #spots > 0) and form.button(ui, "editor:erase", c:t("editor.eraseSelected"), { danger = true }) then
				controls.eraseSelection(c)
			end
		end)
		-- Подвал: что под указателем, ответ правки и кнопки.
		local where = ""
		if tile and hover then
			where = hover.x .. ", " .. hover.y .. " · " .. nameIn(c, TERRAINS, tile.terrain) .. " · " .. nameIn(c, BIOMES, tile.biome)
			if tile.tier ~= nil then
				where ..= " · " .. c:t("editor.tierOf", { tier = tile.tier })
			end
			if tile.cliff then
				where ..= " · " .. c:t("editor.cliff")
			end
			if tile.foot then
				where ..= " · " .. c:t("editor.foot")
			end
		end
		ui:box({ minHeight = 16 }, function()
			ui:text(where .. (if status then (if where ~= "" then " · " else "") .. status else ""), { color = COLORS.dim, wrap = INNER })
		end)
		ui:box({ direction = "row", justify = "end", gap = 4 }, function()
			if form.button(ui, "editor:exit", if leaving then c:t("editor.exit") .. "?" else c:t("editor.exit"), { tip = if leaving then c:t("editor.exitConfirm") else nil, danger = leaving }) then
				if dirty and not leaving then
					leaving = true
				else
					leaving = false
					c.shared.editor = nil
					c.app:to_menu()
				end
			end
			if form.button(ui, "editor:save", c:t("editor.save") .. (if dirty then " •" else ""), { primary = true }) then
				c.app:save()
				c.shared.editorDirty = false
				c.shared.editorSaved = true
				leaving = false
			end
		end)
	end)
	if c.shared.editorDirty then
		c.shared.editorSaved = false
	end
end

return panel
