--!strict
-- Окно исследований — перенос packages/client/src/gui/tech.ts, как в Factorio: сверху очередь, ниже все темы плитками —
-- зелёные можно исследовать сейчас, жёлтые станут можно, когда очередь дойдёт до нужного им, красные — пока нельзя,
-- открытые — в конце. Щелчок ставит тему в конец очереди вместе с недостающими предшественниками, Shift — в начало;
-- щелчок по теме в очереди убирает её. Наведение показывает карточку: что тема даёт и что от неё зависит. Открывается
-- кнопкой «Исследования» на полосе (ui/hud) и клавишей R.

local widgets = require("lib/widgets")
local research = require("lib/research")
local paving = require("lib/paving")
local COLORS, shadow = widgets.COLORS, widgets.shadow

local tech = {}

-- Стороны значков на плитке и в строке; плитка не уже TILE_MIN; промежуток; ширина карточки.
local ICON, SMALL, TILE_MIN, GAP, CARD_WIDTH = 48, 24, 120, 6, 330
-- Высота верхней полосы панели (ui/hud).
local TOP = 38

local STATUS_ORDER = { available = 0, soon = 1, locked = 2, done = 3 }
local STATUS_COLORS = {
	available = { line = COLORS.good, back = "rgb(143 224 168 / 0.2)" },
	soon = { line = COLORS.gold, back = "rgb(240 201 90 / 0.2)" },
	locked = { line = COLORS.bad, back = "rgb(255 122 102 / 0.22)" },
	done = { line = COLORS.steel, back = "rgb(97 132 163 / 0.18)" },
}
local TEXT_COLORS = { available = COLORS.good, soon = COLORS.gold, locked = COLORS.bad, done = COLORS.dim }
local STATUS_TEXT = {
	done = "tech.researched",
	available = "tech.status.available",
	soon = "tech.status.soon",
	locked = "tech.status.locked",
}
local TRIGGERS = {
	lab = "tech.triggers.lab",
	deposit = "tech.triggers.deposit",
	metal = "tech.triggers.metal",
	silicon = "tech.triggers.silicon",
	fuel = "tech.triggers.fuel",
	kharite = "tech.triggers.kharite",
	lithium = "tech.triggers.lithium",
	uranium = "tech.triggers.uranium",
	refined = "tech.triggers.refined",
}

local clockOf = widgets.clock

-- Тема для окна (techOf в hud.ts): ярус, цена, готовность, место в очереди, доступность, что открывает.
local function viewsOf(c)
	local state = research.player(c, c.player)
	local known = state and state.research or {}
	local plan = state and state.plan or {}
	local progress = state and state.progress or {}
	local views = {}
	for _, kind in research.list(c) do
		local name = kind.name
		local after = kind.data.after or {}
		local ready, soon = true, true
		for _, before in after do
			if not table.find(known, before) then
				ready = false
				if not table.find(plan, before) then
					soon = false
				end
			end
		end
		local status = if table.find(known, name) then "done" elseif kind.data.trigger then "locked" elseif ready then "available" elseif soon then "soon" else "locked"
		local price = research.price(c, name)
		local buildings, units = research.unlocks(c, name)
		table.insert(views, {
			topic = name,
			kind = kind,
			tier = research.tier(c, name),
			after = after,
			cost = price.cost,
			materials = price.materials,
			seconds = price.seconds,
			progress = progress[name] or 0,
			status = status,
			trigger = kind.data.trigger,
			order = table.find(plan, name) or 0,
			buildings = buildings,
			units = units,
		})
	end
	return views, plan
end

-- Руда, которую находит открытие месторождения: её значок и рисуется на теме.
local FOUND = { metal = "metalOre", silicon = "siliconOre", fuel = "fuelOre", kharite = "khariteOre", lithium = "lithiumOre", uranium = "uraniumOre" }

-- Значок темы: находка — руда, уровни зданий — свой значок, научный метод — лаборатория, иначе — первое, что тема
-- открывает (iconOf).
local function iconOf(c, view)
	local icon = c.protos.icons[view.topic]
	if icon then
		return icon
	end
	if view.trigger and FOUND[view.trigger] then
		return c.protos.goods[FOUND[view.trigger]]
	end
	if view.trigger == "lab" or (#view.buildings == 0 and #view.units == 0) then
		return c.protos.buildings.lab
	end
	return view.buildings[1] or view.units[1]
end

-- Строка темы: значок и название цвета её доступности.
local function line(c, view)
	local ui = c.ui
	ui:box({ direction = "row", align = "center", gap = 4 }, function()
		ui:image(iconOf(c, view), SMALL, SMALL)
		ui:text(c:t(view.kind.data.title), { color = TEXT_COLORS[view.status] })
	end)
end

-- Цена: монета с кредитами и сырьё.
local function priceRow(c, view, extra: (() -> ())?)
	local ui = c.ui
	ui:box({ direction = "row", align = "center", gap = 6 }, function()
		ui:box({ direction = "row", align = "center", gap = 3 }, function()
			widgets.coin(ui)
			ui:text(tostring(view.cost), { color = COLORS.gold })
		end)
		for good, amount in view.materials do
			local kind = c.protos.goods[good]
			if kind then
				ui:box({ direction = "row", align = "center", gap = 3 }, function()
					ui:image(kind, 20, 20)
					ui:text(tostring(amount), { color = COLORS.soft })
				end)
			end
		end
		if extra then
			extra()
		end
	end)
end

-- Карточка темы: что даёт и открывает, цена или условие, что нужно раньше и что откроется дальше — деревом.
local function card(c, view, byTopic, children)
	local ui = c.ui
	local inner = CARD_WIDTH - 20
	ui:box({ direction = "column", gap = 6, width = inner }, function()
		ui:text(c:t(view.kind.data.title), { font = "title", color = COLORS.bright, wrap = inner })
		ui:text(if view.trigger and view.status ~= "done" then c:t("tech.triggerTopic") else c:t(STATUS_TEXT[view.status]), { color = TEXT_COLORS[view.status] })
		if c:t(view.kind.data.info) then
			ui:text(c:t(view.kind.data.info), { wrap = inner })
		end
		for _, kind in view.buildings do
			ui:box({ direction = "row", align = "center", gap = 4 }, function()
				ui:image(kind, SMALL, SMALL)
				ui:text(c:t(kind.data.title))
			end)
		end
		for _, kind in view.units do
			ui:box({ direction = "row", align = "center", gap = 4 }, function()
				ui:image(kind, SMALL, SMALL)
				ui:text(c:t(kind.data.title))
			end)
		end
		for _, kind in paving.opens(view.topic) do
			ui:box({ direction = "row", align = "center", gap = 4 }, function()
				ui:image(c.protos.icons[paving.ICONS[kind]], SMALL, SMALL)
				ui:text(c:t(paving.TITLES[kind]))
			end)
		end
		if view.trigger then
			if view.status ~= "done" then
				ui:text(c:t(TRIGGERS[view.trigger] or view.trigger), { color = COLORS.power, wrap = inner })
			end
		elseif view.status ~= "done" then
			priceRow(c, view, function()
				ui:space(0, 0, 1)
				ui:text(c:t("tech.time", { time = clockOf(view.seconds) }), { color = COLORS.dim })
			end)
		end
		if #view.after > 0 then
			ui:box({ direction = "column", gap = 2 }, function()
				ui:text(c:t("tech.before"), { color = COLORS.dim })
				for _, before in view.after do
					line(c, byTopic[before])
				end
			end)
		end
		if children[view.topic] and #children[view.topic] > 0 then
			ui:box({ direction = "column", gap = 2 }, function()
				ui:text(c:t("tech.leadsTo"), { color = COLORS.dim })
				-- Каждая тема — один раз, там, где встретилась впервые; вложенность — отступом.
				local seen = { [view.topic] = true }
				local function walk(topic: string, depth: number)
					local next = {}
					for _, child in children[topic] or {} do
						if not seen[child] then
							seen[child] = true
							table.insert(next, child)
						end
					end
					for _, child in next do
						ui:box({ padding = { 0, 0, 0, 6 + depth * 14 } }, function()
							line(c, byTopic[child])
						end)
						walk(child, depth + 1)
					end
				end
				walk(view.topic, 0)
			end)
		end
	end)
end

-- Плитка темы: значок на цвете доступности, место в очереди, готовность, название, цена и срок.
local function tile(c, view, width: number, byTopic, children)
	local ui = c.ui
	local id = "tech:" .. view.topic
	-- Тему-открытие и открытую в очередь не ставят.
	local idle = view.status == "done" or view.trigger ~= nil
	local colors = STATUS_COLORS[view.status]
	local click = ui:button(id, { width = width, direction = "column", align = "stretch", justify = "start", gap = 2, padding = 6, active = view.order > 0, alpha = if view.status == "done" then 0.7 else nil }, function()
		ui:box({ height = 56, direction = "stack", background = colors.back }, function()
			ui:box({ self = { "center", "center" } }, function()
				ui:image(iconOf(c, view), ICON, ICON)
			end)
			ui:box({ self = { "start", "end" }, width = width - 12, height = 3, background = colors.line })
			if view.order > 0 then
				ui:box({ self = { "end", "start" }, background = COLORS.teamDark, padding = { 0, 4 } }, function()
					ui:text(tostring(view.order), { color = COLORS.bright })
				end)
			end
			if view.status ~= "done" and view.progress > 0 then
				ui:box({ self = { "center", "end" }, padding = { 0, 0, 6, 0 } }, function()
					ui:box({ width = width - 20, height = 4, background = COLORS.well, direction = "row" }, function()
						ui:box({ width = math.round((width - 20) * view.progress), height = 4, background = COLORS.team })
					end)
				end)
			end
		end)
		ui:box({ minHeight = 28, padding = { 0, 2 } }, function()
			ui:text(c:t(view.kind.data.title), shadow({ color = COLORS.bright, wrap = width - 16 }))
		end)
		if view.status ~= "done" and not view.trigger then
			ui:box({ direction = "row", align = "center", gap = 6, padding = { 0, 2 } }, function()
				ui:box({ direction = "row", align = "center", gap = 3 }, function()
					widgets.coin(ui)
					ui:text(tostring(view.cost), { color = COLORS.gold })
				end)
				ui:space(0, 0, 1)
				ui:text(clockOf(view.seconds), { color = COLORS.dim })
			end)
		end
		if view.trigger and view.status ~= "done" then
			ui:box({ padding = { 0, 2 } }, function()
				ui:text(c:t(TRIGGERS[view.trigger] or view.trigger), { color = COLORS.power, wrap = width - 16 })
			end)
		end
	end)
	-- Карточка — справа от плитки, а у правого края экрана — слева; в нижней половине — вровень с низом плитки.
	local at = ui:rect(id)
	if at then
		local right = at.x + at.width + 8 + CARD_WIDTH > ui.width
		local low = at.y > ui.height / 2
		local anchor = {}
		if right then
			anchor.right = ui.width - at.x + 8
		else
			anchor.left = at.x + at.width + 8
		end
		if low then
			anchor.bottom = math.max(8, ui.height - at.y - at.height)
		else
			anchor.top = at.y
		end
		ui:tip(id, function()
			card(c, view, byTopic, children)
		end, anchor)
	end
	if click and not idle then
		c:send("research", { topic = view.topic, front = click.shift })
	end
end

-- Лаборатории игрока: сколько, сколько работают, суммарная скорость и чего не хватает стоящим.
local function labsOf(c)
	local count, working, speed, lacks, order = 0, 0, 0, {}, {}
	for _, e in c:each({ "Research", "Building", "Owner" }) do
		if research.isLab(c, c.player, e) then
			local lab = c:get(e, "Research")
			count += 1
			speed += lab.speed
			if lab.speed > 0 then
				working += 1
			end
			if lab.lack ~= "" and lab.lack ~= "idle" then
				if not lacks[lab.lack] then
					lacks[lab.lack] = 0
					table.insert(order, lab.lack)
				end
				lacks[lab.lack] += 1
			end
		end
	end
	return { count = count, working = working, speed = math.round(speed * 100) / 100, lacks = lacks, order = order }
end

-- Почему лаборатории стоят: «кредитов», «энергии», «включения» или название груза.
local function lackName(c, lack: string): string
	if lack == "credits" then
		return c:t("tech.lackCredits")
	elseif lack == "off" then
		return c:t("tech.lackOff")
	elseif lack == "power" or lack == "idle" then
		return c:t("tech.lackPower")
	end
	local kind = c.protos.goods[lack]
	return if kind then c:t(kind.data.title) else lack
end

-- Открыто ли окно; клавиша R и Esc — открыть и закрыть.
function tech.open(c): boolean
	return c.shared.techOpen == true
end

function tech.draw(c)
	local ui = c.ui
	local input = c.input
	if input.hits.r and not input.keys.ctrl and not c.shared.paused then
		c.shared.techOpen = not c.shared.techOpen
	end
	if not c.shared.techOpen or c.shared.paused then
		return
	end
	local views, plan = viewsOf(c)
	local byTopic, children = {}, {}
	for _, view in views do
		byTopic[view.topic] = view
		for _, before in view.after do
			children[before] = children[before] or {}
			table.insert(children[before], view.topic)
		end
	end
	local function ordered(status: { string })
		local list = {}
		for _, view in views do
			if table.find(status, view.status) then
				table.insert(list, view)
			end
		end
		table.sort(list, function(a, b)
			if STATUS_ORDER[a.status] ~= STATUS_ORDER[b.status] then
				return STATUS_ORDER[a.status] < STATUS_ORDER[b.status]
			end
			if a.tier ~= b.tier then
				return a.tier < b.tier
			end
			return a.kind.data.order < b.kind.data.order
		end)
		return list
	end
	local open, later, done = ordered({ "available", "soon" }), ordered({ "locked" }), ordered({ "done" })
	local labs = labsOf(c)
	local current = research.current(c, c.player)
	local width = math.min(1180, ui.width - 16)
	local height = ui.height - TOP - 16
	local inner = width - 40
	local columns = math.max(1, math.floor((inner - 4 + GAP) / (TILE_MIN + GAP)))
	local tileWidth = math.floor((inner - 4 - GAP * (columns - 1)) / columns)
	-- Сколько ещё идти нынешней теме при нынешней скорости.
	local left = nil
	if current and labs.speed > 0 then
		left = clockOf((1 - (byTopic[current].progress)) * byTopic[current].seconds / labs.speed)
	end

	local function grid(list)
		ui:box({ direction = "column", gap = GAP }, function()
			for start = 1, #list, columns do
				ui:box({ direction = "row", gap = GAP, align = "stretch" }, function()
					for i = start, math.min(#list, start + columns - 1) do
						tile(c, list[i], tileWidth, byTopic, children)
					end
				end)
			end
		end)
	end

	ui:box({ id = "tech", anchor = { centerX = 0, top = TOP + 8 }, width = width, height = height, skin = "panel", padding = { 16, 20 }, direction = "column", align = "stretch", gap = 8 }, function()
		ui:box({ direction = "row", align = "center", gap = 16 }, function()
			ui:text(c:t("tech.title"), { font = "title", color = COLORS.bright, shadow = COLORS.ink, lift = 2 })
			ui:text(if labs.count == 0 then c:t("tech.noLabs") else c:t("tech.labs", { count = labs.count, working = labs.working, speed = labs.speed }), { color = COLORS.dim })
			ui:space(0, 0, 1)
			if ui:button("tech:close", { padding = { 2, 8 } }, function()
				ui:text("✕", shadow())
			end) then
				c.shared.techOpen = false
			end
			ui:tip("tech:close", c:t("tech.closeTip"))
		end)

		ui:box({ direction = "row", align = "center", gap = 6, minHeight = 36, clip = true }, function()
			ui:text(c:t("tech.queue"), { color = COLORS.dim })
			if #plan == 0 then
				ui:text(c:t("tech.queueEmpty"), { color = COLORS.dim })
			end
			for i, topic in plan do
				local view = byTopic[topic]
				if not view then
					continue
				end
				local id = "tech:queued:" .. topic
				local click = ui:button(id, { padding = { 2, 6, 2, 2 }, gap = 4, active = topic == current }, function()
					ui:image(iconOf(c, view), SMALL, SMALL)
					ui:text(c:t(view.kind.data.title), shadow())
					if i == 1 then
						ui:text(math.round(view.progress * 100) .. "%" .. (if left then " · " .. left else ""), { color = COLORS.team })
					end
				end)
				ui:tip(id, c:t("tech.dequeueTip"))
				if click then
					c:send("dequeue", { topic = topic })
				end
			end
			if #plan > 0 then
				ui:space(0, 0, 1)
				if ui:button("tech:clear", { padding = { 2, 10 } }, function()
					ui:text(c:t("tech.cancel"), shadow())
				end) then
					c:send("cancelResearch", {})
				end
				ui:tip("tech:clear", c:t("tech.cancelTip"))
			end
		end)
		if current and #labs.order > 0 then
			ui:box({ direction = "row", align = "center", gap = 12 }, function()
				ui:text(c:t("tech.lacks"), { color = COLORS.warn })
				for _, lack in labs.order do
					ui:box({ direction = "row", align = "center", gap = 2 }, function()
						local kind = c.protos.goods[lack]
						if kind then
							ui:image(kind, 20, 20)
						end
						ui:text(lackName(c, lack), { color = COLORS.warn })
						ui:text(" " .. c:t("tech.labCount", { count = labs.lacks[lack] }), { color = COLORS.dim })
					end)
				end
			end)
		end

		ui:box({ id = "tech:list", grow = 1, direction = "column", gap = 6, scroll = true, padding = 2 }, function()
			grid(open)
			if #later > 0 then
				ui:box({ padding = { 6, 0, 0, 0 } }, function()
					ui:text(c:t("tech.later"), { color = COLORS.muted })
				end)
				grid(later)
			end
			if #done > 0 then
				ui:box({ padding = { 6, 0, 0, 0 } }, function()
					ui:text(c:t("tech.researched"), { color = COLORS.muted })
				end)
				grid(done)
			end
		end)
		ui:text(c:t("tech.hint"), { color = COLORS.muted, wrap = inner })
	end)
end

return tech
