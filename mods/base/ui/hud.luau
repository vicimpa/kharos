--!strict
-- Панель игрока: верхняя полоса и нижняя — мини-карта, сведения о выбранном, сетка команд 4 × 3.

local widgets = require("lib/widgets")
local stats = require("lib/stats")
local conversion = require("lib/conversion")
local defeat = require("lib/defeat")
local construction = require("lib/construction")
local kinds = require("lib/kinds")
local economy = require("lib/economy")
local goods = require("lib/goods")
local supply = require("lib/supply")
local logistics = require("lib/logistics")
local research = require("lib/research")
local tactics = require("lib/tactics")
local trade = require("lib/trade")
local silos = require("mechanics/silos")
local alertsLib = require("lib/alerts")
local missiles = require("lib/missiles")
local stepsLib = require("lib/steps")
local depositsLib = require("lib/deposits")
local levels = require("lib/levels")
local paving = require("lib/paving")
local earthworks = require("lib/earthworks")
local truckControls = require("controls/trucks")
local seenLib = require("lib/seen")
local wallet = require("lib/wallet")

local clockOf = widgets.clock
local COLORS, shadow = widgets.COLORS, widgets.shadow

local hud = {}

-- Верхняя полоса и нижняя панель: высоты, ячейки, портреты.
local TOP_HEIGHT = 38
local INNER = 140
local CELL_WIDTH = 132
local GRID_WIDTH = 4 * CELL_WIDTH + 3 * 4
local BAR_SPACING = 16 + 8 + 8
local PORTRAIT = 96
local TILE = 32
local QUEUED = 24
-- Сторона мини-карты: из настроек игрока, но не больше, чем оставляет сведениям ширина экрана.
local settings = require("lib/settings")
local world = require("lib/world")
local INFO_MIN = 104 + 10 + 24 + 150
local GRID_KEYS = { "T", "Y", "U", "I", "G", "H", "J", "K", "B", "N", "M", "," }
-- Постоянные места сетки: превращение, отмена, разбор и «Назад»; выключатель — на месте «Назад».
local CONVERT, CANCEL, DEMOLISH, BACK = 9, 10, 11, 12
-- Улучшение здания: конец второго ряда корня — у зданий, которые улучшают, списков там нет.
local UPGRADE = 8
local SWITCH = BACK
-- Названия инструментов протяжки: стена и ворота — как здание.
local TOOL_NAMES = { pipe = "grid.tools.pipe", well = "grid.tools.well", foundation = paving.TITLES.foundation, road = paving.TITLES.road, remove = paving.TITLES.remove, peak = paving.TITLES.peak, cliff = paving.TITLES.cliff }
-- Инструменты раздела «Покрытие» и их подсказки: цена тайла — {cost}, моста — {bridge}.
local PAVE_TOOLS = { "foundation", "road", "peak", "cliff" }
local PAVE_TIPS = {
	foundation = "grid.toolTips.foundation",
	road = "grid.toolTips.road",
	peak = "grid.toolTips.peak",
	cliff = "grid.toolTips.cliff",
}
-- Цена тайла инструмента «Покрытия».
local PAVE_COSTS = { foundation = paving.FOUNDATION_COST, road = paving.ROAD_COST, peak = earthworks.PEAK_COST, cliff = earthworks.CLIFF_COST }
-- С какой доли выработки полная нагрузка сети уже тесна: число энергии на полосе желтеет.
local GRID_TIGHT = 0.8
-- Разделы строителя: в какой странице какое здание; остальное — хозяйство. Раздел — с картинкой здания, по порядку
-- кнопок.
local SECTIONS = {
	{ page = "economy", label = "grid.sections.economy", tip = "grid.sectionTips.economy", picture = "generator" },
	{ page = "storage", label = "grid.sections.storage", tip = "grid.sectionTips.storage", picture = "metalYard", list = { "metalYard", "siliconStore", "fuelTank", "khariteVault", "lithiumStore", "uraniumCask", "blockYard", "ammoBunker", "partsLocker", "rodRack", "requestStation" } },
	{ page = "industry", label = "grid.sections.industry", tip = "grid.sectionTips.industry", picture = "smelter", list = { "smelter", "siliconWorks", "distillery", "enricher", "evaporator", "uraniumMill" } },
	{ page = "production", label = "grid.sections.production", tip = "grid.sectionTips.production", picture = "blockPlant", list = { "blockPlant", "ammoPlant", "partsPlant", "rodPlant" } },
	{ page = "military", label = "grid.sections.military", tip = "grid.sectionTips.military", picture = "factory", list = { "barracks", "factory", "airfield", "repairStation", "supplyDepot", "silo" } },
	{ page = "defense", label = "grid.sections.defense", tip = "grid.sectionTips.defense", picture = "wall", list = { "wall", "gate", "turret", "rocketTurret", "cannonTurret", "laserTurret", "arcTurret", "shieldGenerator", "interceptor", "radar" } },
}

-- Стойки бойцов: подпись и подсказка (grid.stances и grid.stanceTips в ru.json).
local STANCES = {
	aggressive = { label = "grid.stances.aggressive", tip = "grid.stanceTips.aggressive" },
	defensive = { label = "grid.stances.defensive", tip = "grid.stanceTips.defensive" },
	hold = { label = "grid.stances.hold", tip = "grid.stanceTips.hold" },
	passive = { label = "grid.stances.passive", tip = "grid.stanceTips.passive" },
}

-- Пульс подсказки «Первых шагов»: обводка огнями команды разгорается и гаснет раз в секунду от low до high; восемь
-- ступеней — плавнее не разглядеть.
local function pulse(ui, low: number, high: number, color: string?, period: number?): string
	local phase = (ui.now / (period or 1)) % 1
	local level = math.round((low + (high - low) * (0.5 - 0.5 * math.cos(phase * math.pi * 2))) * 8) / 8
	return string.format("rgba(%s / %g)", color or "90 169 255", level)
end

-- Текущий первый шаг новичка (lib/steps): его кнопки подсвечены; nil — пройдены все.
local function currentStep(c)
	return stepsLib.of(c).step
end

-- Раздел здания по имени: где его нет в списках, там хозяйство.
local function sectionOf(name: string): string
	for _, section in SECTIONS do
		if section.list and table.find(section.list, name) then
			return section.page
		end
	end
	return "economy"
end

-- Доля процентом.
local function percent(value: number): string
	return math.floor(value * 100 + 0.5) .. "%"
end
local KEY_NAMES = { "t", "y", "u", "i", "g", "h", "j", "k", "b", "n", "m", "," }

-- Число, как его пишет JS: до сотых, без лишних нулей.
local function number(value: number): string
	local rounded = math.round(value * 100) / 100
	if rounded == math.floor(rounded) then
		-- + 0: отрицательный ноль — просто ноль.
		return tostring(math.floor(rounded) + 0)
	end
	return (string.gsub(string.format("%.2f", rounded), "0+$", ""))
end

-- Энергия сети для подписи: выработка повреждённых станций дробная — до десятых и вниз, а спрос — вверх, чтобы нехватка
-- не выглядела как «20 из 20».
local function gridState(e: economy.Economy)
	return {
		produced = math.floor(e.produced * 10) / 10,
		demand = math.ceil(e.demand * 10 - 1e-9) / 10,
		peak = math.ceil(e.peak * 10 - 1e-9) / 10,
		stored = math.round(e.stored * 100) / 100,
		overload = economy.overloadOf(e) > 0,
	}
end

-- Подпись энергии сети.
local function gridText(c, grid): string
	return c:t("hud.zonePower", { demand = number(grid.demand), produced = number(grid.produced) })
		.. (if grid.stored > 0 then c:t("hud.zoneStored", { stored = number(grid.stored) }) else "")
		.. (if grid.peak > grid.demand then c:t("hud.zonePeak", { peak = number(grid.peak) }) else "")
		.. (if grid.overload then c:t("hud.overloaded") else "")
end

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
	return if shown then gridState(shown) else nil
end

-- Значок груза с количеством.
local function goodWith(c, good: string, amount: number?, size: number?, of: number?)
	local ui = c.ui
	local kind = c.protos.goods[good]
	ui:box({ direction = "row", align = "center", gap = 4 }, function()
		if kind then
			ui:image(kind, size or 20, size or 20)
		end
		if amount then
			ui:text(tostring(math.floor(amount)) .. (if of then "/" .. math.floor(of) else ""))
		end
	end)
end

-- Запас груза и что с ним: «Название: значок есть/из» строкой, пояснение — абзацем под ней.
local function stockHint(c, label: string, good: string, have: number, capacity: number, note: string, tone: string, width: number)
	local ui = c.ui
	ui:box({ direction = "row", align = "center", gap = 6, width = width }, function()
		ui:text(label .. ":", { color = tone })
		goodWith(c, good, have, 20, capacity)
	end)
	-- Пояснение в словаре продолжает строку с запасом («. Расстреляет…», « — пусто…»): здесь оно со своей строки.
	ui:text(widgets.capital((string.gsub(note, "^[%s%.—]+", ""))), { color = tone, wrap = width })
end

-- Груз списком значков: что лежит, по порядку грузов.
local function goodsRow(c, items: { [string]: number }, empty: string?)
	local ui = c.ui
	ui:box({ direction = "row", align = "center", gap = 8 }, function()
		local any = false
		for _, name in goods.names(c) do
			local amount = items[name] or 0
			if amount >= 1 then
				goodWith(c, name, amount, 20)
				any = true
			end
		end
		if not any and empty then
			ui:text(empty)
		end
	end)
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
		local grid = shownGrid(c)
		if grid then
			local color = if grid.demand > grid.produced or grid.overload then COLORS.bad elseif grid.peak > grid.produced * GRID_TIGHT then COLORS.warn else COLORS.power
			ui:box({ id = "grid" }, function()
				ui:text("⚡ " .. number(grid.demand) .. " / " .. number(grid.produced), { color = color })
			end)
			ui:tip("grid", gridText(c, grid) .. "\n" .. c:t("hud.gridTip"))
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

-- Превращение выбранного: MCV разворачивается, главное здание сворачивается; nil — не то.
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

-- Свои строители среди выбранного.
local function buildersOf(c, selection): { number }
	local list = {}
	for _, e in selection do
		if c:mine(e) and c:has(e, "Unit") and c:has(e, "Repair") then
			table.insert(list, e)
		end
	end
	return list
end

-- Описание здания для карточки: что делает и какие здания открывает.
local function aboutOf(c, kind): string
	local info = c:t(kind.data.info) or ""
	local opens = {}
	for _, other in construction.menu(c) do
		if other.data.requires and table.find(other.data.requires, kind.name) then
			table.insert(opens, c:t(other.data.title) or other.name)
		end
	end
	return if #opens > 0 then c:t("grid.unlocks", { info = info, list = table.concat(opens, ", ") }) else info
end

-- Страница сетки строителя: корень с разделами или здания раздела; сменилось выделение — снова корень.
local page = { name = "root", key = "" }

-- Ячейки стройки (construction в commandsOf): на корне — разделы с открытыми зданиями, в разделе — сами здания
-- и «Назад». Кнопка здания включает выбор места; закладывают и без кредитов — стройка подождёт их.
local function constructionSlots(c, list, selection)
	local key = table.concat(selection, ",")
	if page.key ~= key then
		page.name, page.key = "root", key
	end
	local mode = c.shared.mode
	local placing = if mode ~= nil and mode.kind == "placing" then mode.building else nil
	local stroking = if mode ~= nil and mode.kind == "paving" then mode.tool else nil
	-- Трубы и колодцы открывают исследования: раздел «Логистика» — с первым открытым инструментом.
	local tools = {}
	for _, tool in { "pipe", "well" } do
		local kind = c.protos.buildings[tool]
		if kind and construction.researched(c, c.player, kind.data.research) then
			table.insert(tools, kind)
		end
	end
	-- Покрытие открывают исследования: раздел — с первым открытым инструментом.
	local surfaces = {}
	if paving.enabled(c) then
		for _, tool in PAVE_TOOLS do
			if construction.researched(c, c.player, paving.RESEARCH[tool]) then
				table.insert(surfaces, tool)
			end
		end
	end
	local free = construction.freeCredits(c, c.player)
	local options = {}
	for _, kind in construction.menu(c) do
		if construction.unlocked(c, c.player, kind) then
			table.insert(options, kind)
		end
	end
	local step = currentStep(c)
	if page.name == "root" then
		for i, section in SECTIONS do
			local count, hint, fresh = 0, false, false
			for _, kind in options do
				if sectionOf(kind.name) == section.page then
					count += 1
					hint = hint or (step ~= nil and step.building == kind.name)
					-- Раздел подсвечен, пока в нём есть кнопка, которую игрок ещё не нажимал.
					fresh = fresh or not seenLib.is(c, kind.name)
				end
			end
			-- Раздел появляется, когда в нём открыто хоть одно здание; закрытый оставляет пустую ячейку.
			if count > 0 then
				list[i] = {
					label = c:t(section.label),
					picture = c.protos.buildings[section.picture],
					title = c:t(section.tip),
					count = count,
					hint = hint,
					fresh = fresh,
					run = function()
						page.name = section.page
					end,
				}
			end
		end
		if #surfaces > 0 then
			list[#SECTIONS + 1] = {
				label = c:t("grid.sections.paving"),
				picture = c.protos.icons.roads,
				title = c:t("grid.sectionTips.paving"),
				count = #surfaces,
				fresh = (function()
					for _, tool in surfaces do
						if not seenLib.is(c, tool) then
							return true
						end
					end
					return false
				end)(),
				run = function()
					page.name = "paving"
				end,
			}
		end
		-- Разбор рамкой — сразу инструмент, без раздела, на месте «Разобрать» здания.
		if paving.enabled(c) then
			local active = stroking == "remove"
			list[DEMOLISH] = {
				label = c:t(paving.TITLES.remove),
				picture = c.protos.icons.remove,
				active = active,
				title = c:t("grid.removeTip"),
				run = function()
					c.shared.mode = if active then nil else { kind = "paving", tool = "remove" }
				end,
			}
		end
		if #tools > 0 then
			list[#SECTIONS + 2] = {
				label = c:t("grid.sections.logistics"),
				picture = c.protos.buildings.pipe,
				title = c:t("grid.sectionTips.logistics"),
				count = #tools,
				fresh = (function()
					for _, kind in tools do
						if not seenLib.is(c, kind.name) then
							return true
						end
					end
					return false
				end)(),
				run = function()
					page.name = "logistics"
				end,
			}
		end
		return
	end
	if page.name == "paving" then
		for i, tool in PAVE_TOOLS do
			-- Неисследованный инструмент — пустая ячейка: остальные не сдвигаются.
			if not table.find(surfaces, tool) then
				continue
			end
			local active = stroking == tool
			local shown = c.shared.paving
			local cost = PAVE_COSTS[tool]
			list[i] = {
				label = c:t(paving.TITLES[tool]),
				picture = c.protos.icons[paving.ICONS[tool]],
				cost = if active and shown and shown.tiles > 1 then shown.cost else cost,
				title = c:t(PAVE_TIPS[tool], { cost = PAVE_COSTS[tool], bridge = paving.BRIDGE_COST }),
				active = active,
				fresh = not seenLib.is(c, tool),
				seen = tool,
				run = function()
					seenLib.mark(c, tool)
					c.shared.mode = if active then nil else { kind = "paving", tool = tool }
				end,
			}
		end
		list[BACK] = {
			label = c:t("common.back"),
			title = c:t("grid.backFromPlacing"),
			run = function()
				if stroking then
					c.shared.mode = nil
				end
				page.name = "root"
			end,
		}
		return
	end
	if page.name == "logistics" then
		local tips = {
			pipe = c:t("grid.toolTips.pipe"),
			well = c:t("grid.toolTips.well", { reach = 10 }),
		}
		for i, kind in tools do
			local active = stroking == kind.name
			local shown = c.shared.paving
			list[i] = {
				label = c:t(TOOL_NAMES[kind.name] or kind.data.title),
				picture = kind,
				cost = if active and shown and shown.tiles > 1 then shown.cost else kind.data.cost,
				short = free < kind.data.cost,
				title = tips[kind.name],
				active = active,
				zones = true,
				fresh = not seenLib.is(c, kind.name),
				seen = kind.name,
				run = function()
					seenLib.mark(c, kind.name)
					c.shared.mode = if active then nil else { kind = "paving", tool = kind.name }
				end,
			}
		end
		list[BACK] = {
			label = c:t("common.back"),
			title = c:t("grid.backFromPlacing"),
			run = function()
				if stroking then
					c.shared.mode = nil
				end
				page.name = "root"
			end,
		}
		return
	end
	local index = 0
	for _, kind in options do
		if sectionOf(kind.name) ~= page.name or index >= BACK - 1 then
			continue
		end
		index += 1
		local affordable = free >= kind.data.cost
		-- Энергию кнопки показывают для первой сети: в какую попадёт здание, до выбора места неизвестно.
		local zone = economy.zones(c, c.player)[1] or economy.of(c, c.player)
		local power = economy.powerOf(kind, zone)
		local idle = economy.idlePowerOf(kind, zone)
		list[index] = {
			label = c:t(kind.data.title) or kind.name,
			picture = kind,
			cost = kind.data.cost,
			materials = kind.data.materials,
			c = c,
			stock = (logistics.stockOf(c, c.player)),
			power = if power ~= 0 then power else nil,
			idle = if idle ~= power then idle else nil,
			short = not affordable,
			about = aboutOf(c, kind),
			title = if affordable then nil else c:t("grid.shortCredits"),
			active = placing == kind.name,
			zones = true,
			hint = step ~= nil and step.building == kind.name,
			fresh = not seenLib.is(c, kind.name),
			seen = kind.name,
			run = function()
				seenLib.mark(c, kind.name)
				c.shared.mode = if placing == kind.name then nil else { kind = "placing", building = kind.name }
			end,
		}
		-- Стену и ворота не ставят по одной, а тянут мышью линией, как трубу: их кнопка включает протяжку.
		if kind.name == "wall" or kind.name == "gate" then
			local slot = list[index]
			local active = stroking == kind.name
			local shown = c.shared.paving
			slot.active = active
			slot.cost = if active and shown and shown.tiles > 1 then shown.cost else kind.data.cost
			slot.title = if affordable then c:t("grid.wallTip") else c:t("grid.wallTip") .. ". " .. c:t("grid.shortCredits")
			slot.run = function()
				seenLib.mark(c, kind.name)
				c.shared.mode = if active then nil else { kind = "paving", tool = kind.name }
			end
		end
	end
	list[BACK] = {
		label = c:t("common.back"),
		title = c:t("grid.backFromPlacing"),
		run = function()
			if placing or stroking then
				c.shared.mode = nil
			end
			page.name = "root"
		end,
	}
end

-- Ячейки сетки команд для выбранного: у строителей — стройка, у своего завода — заказ юнитов, у MCV и главного здания —
-- превращение, у своей стройки — отмена, у готового здания — разбор. Торговля у космопорта: страница — корень, продажа
-- или закупка; deal — набираемая сделка: что и сколько. Сбрасывается, когда выбран другой космопорт.
local DEAL_STEPS = { 10, 50, 100 }
local DEAL_START = 50
local market = { port = -1, page = "root", deal = nil :: { resource: string, amount: number }? }

-- Что можно продать из запаса игрока: сколько всего, сколько в сети космопорта и почём.
local function offersOf(c, port: number)
	local items = logistics.stockOf(c, c.player)
	local network = logistics.networkOf(c, port)
	local near = if network then trade.stockOfZone(c, network) else {}
	local list = {}
	for _, name in goods.names(c) do
		local available = math.floor(items[name] or 0)
		if trade.isResource(c, name) and available >= 1 then
			table.insert(list, { resource = name, available = available, here = math.floor(near[name] or 0), price = trade.price(c, name) })
		end
	end
	return list
end

-- Что можно купить с орбиты: почём, сколько влезет в склад космопорта и что надо изучить.
local function purchasesOf(c, port: number)
	local hold = c:get(port, "Inventory")
	local list = {}
	for _, name in goods.names(c) do
		if trade.isOrbital(c, name) then
			table.insert(list, { resource = name, price = trade.buyPrice(c, name), room = if hold then math.floor(goods.room(hold, name)) else 0, research = trade.buyResearch(c, c.player, name) })
		end
	end
	return list
end

-- Сделка в пределах возможного: продажа — не больше запаса, закупка — на сколько хватает кредитов и трюма. nil — такого
-- ресурса космопорт сейчас не предлагает.
local function dealOf(c, port: number, buying: boolean, deal)
	local item, room = nil, 0
	for _, purchase in purchasesOf(c, port) do
		if purchase.resource == deal.resource then
			room = purchase.room
			if buying then
				item = purchase
			end
		end
	end
	if not buying then
		for _, offer in offersOf(c, port) do
			if offer.resource == deal.resource then
				item = offer
			end
		end
	end
	if not item then
		return nil
	end
	local max = if buying then math.max(0, math.min(room, math.floor(wallet.credits(c, c.player) / item.price))) else item.available
	return { resource = item.resource, amount = math.max(0, math.min(max, math.floor(deal.amount))), price = item.price, max = max, room = room }
end

-- Сетка космопорта: продажа и закупка — каждая на своей странице, набор количества, заявка.
local function tradeSlots(c, list, port: number)
	if market.port ~= port then
		market.port, market.page, market.deal = port, "root", nil
	end
	local order = c:get(port, "Trade")
	local function open(page: string)
		market.page, market.deal = page, nil
	end
	if market.page == "root" then
		list[CONVERT] = {
			label = c:t("grid.sell"),
			picture = c.protos.buildings.spaceport,
			active = order ~= nil,
			title = if order then c:t("grid.sellingTip") else c:t("grid.sellTip"),
			hint = order == nil and (currentStep(c) or {}).sell == true,
			run = function()
				open("sell")
			end,
		}
		list[CANCEL] = {
			label = c:t("grid.buy"),
			picture = c.protos.buildings.spaceport,
			disabled = order ~= nil,
			title = if order then c:t("grid.buyBusyTip") else c:t("grid.buyTip"),
			run = function()
				open("buy")
			end,
		}
	elseif not order then
		local buying = market.page == "buy"
		local picked = market.deal and dealOf(c, port, buying, market.deal)
		if not picked then
			-- Сначала — что продать или купить: ячейка на ресурс. Количество — на следующем шаге.
			local items = if buying then purchasesOf(c, port) else offersOf(c, port)
			for i, item in items do
				if i > 8 then
					break
				end
				local limit = dealOf(c, port, buying, { resource = item.resource, amount = DEAL_START })
				local title = c:t(c.protos.goods[item.resource].data.title)
				local topic = item.research and research.topic(c, item.research)
				list[i] = {
					label = if buying then title else title .. " ×" .. limit.max,
					picture = c.protos.goods[item.resource],
					disabled = limit.max < 1 or item.research ~= nil,
					title = if topic then c:t("grid.needsResearch", { name = c:t(topic.data.title) })
						elseif limit.max >= 1 then (if buying then c:t("grid.buyPrice", { price = item.price })
							elseif item.here and item.here < limit.max then c:t("grid.sellFar", { price = item.price, here = item.here })
							else c:t("grid.sellPrice", { price = item.price }))
						elseif limit.room < 1 and buying then c:t("grid.noRoom")
						else c:t("grid.noCredits"),
					run = function()
						market.deal = { resource = item.resource, amount = limit.amount }
					end,
				}
			end
			list[BACK] = {
				label = c:t("common.back"),
				run = function()
					open("root")
				end,
			}
		else
			-- Верхний ряд — прибавить, второй — убавить; «Всё» — сколько есть в запасе или на сколько хватает кредитов и
			-- трюма.
			local resource, amount, price, max = picked.resource, picked.amount, picked.price, picked.max
			local function set(value: number)
				market.deal = { resource = resource, amount = math.max(0, math.min(max, value)) }
			end
			for i, step in DEAL_STEPS do
				list[i] = { label = "+" .. step, disabled = amount >= max, run = function()
					set(amount + step)
				end }
				list[i + 4] = { label = "−" .. step, disabled = amount <= 0, run = function()
					set(amount - step)
				end }
			end
			list[#DEAL_STEPS + 1] = { label = c:t("grid.all"), active = amount >= max, title = "×" .. max, run = function()
				set(max)
			end }
			list[CONVERT] = {
				label = (if buying then c:t("grid.buy") else c:t("grid.sell")) .. " ×" .. amount,
				picture = c.protos.goods[resource],
				cost = amount * price,
				gain = not buying,
				disabled = amount < 1,
				title = if buying then c:t("grid.buyPrice", { price = price }) else c:t("grid.sellPrice", { price = price }),
				run = function()
					c:send(if buying then "buy" else "sell", { port = port, resource = resource, amount = amount })
					market.deal = nil
				end,
			}
			list[BACK] = {
				label = c:t("common.back"),
				run = function()
					market.deal = nil
				end,
			}
		end
	else
		if order.total <= 0 and not order.buy then
			local delivered = math.floor(trade.delivered(c, port))
			list[CANCEL] = {
				label = if delivered > 0 then c:t("grid.send") else c:t("grid.dropSale"),
				title = if delivered > 0 then c:t("grid.sendTip") else nil,
				run = function()
					c:send("closeSale", { port = port })
				end,
			}
		end
		list[BACK] = {
			label = c:t("common.back"),
			run = function()
				open("root")
			end,
		}
	end
end

-- Уничтожить выбранных своих юнитов: сначала кнопка, потом подтверждение на своей странице — и на другой клавише. key —
-- выделение, для которого открыто подтверждение; сменилось — страница закрыта.
local scuttling = { key = "" }

local function scuttleSlots(c, selection): { any }?
	local key = table.concat(selection, ",")
	if scuttling.key ~= key then
		scuttling.key = ""
		return nil
	end
	local gift = defeat.giftable(c, c.player, selection)
	if #gift == 0 then
		scuttling.key = ""
		return nil
	end
	local list = {}
	list[1] = {
		label = c:t("grid.scuttleConfirm", { count = #gift }),
		title = c:t("grid.scuttleConfirmTip"),
		run = function()
			c:send("scuttle", { units = gift })
			scuttling.key = ""
		end,
	}
	list[BACK] = {
		label = c:t("common.back"),
		run = function()
			scuttling.key = ""
		end,
	}
	return list
end

-- Уровень выбранных своих готовых зданий, которые улучшают: level, gain и factor — первого из них; next — заказ
-- следующего уровня всем, кого можно поднять сейчас: цена вместе и чего не хватает; raising — те, что уже поднимают, и
-- как идёт работа у первого из них. nil — таких зданий не выбрано.
local function levelState(c, selection)
	local state = nil
	local materials = {}
	for _, e in selection do
		local kind = kinds.of(c, e)
		local gain = kind and world.isReady(c, c.player, e) and levels.gain(kind)
		if not gain then
			continue
		end
		local level = levels.of(c, e)
		state = state or { level = level, gain = gain, factor = levels.factor(level) }
		local upgrade = c:get(e, "Upgrade")
		if upgrade then
			if not state.raising then
				local ticks = construction.workTicks(levels.cost(kind, level, upgrade.scale).credits, c.step)
				state.raising = { buildings = {}, progress = math.min(1, upgrade.progress / math.max(1, ticks)) }
			end
			table.insert(state.raising.buildings, e)
		elseif levels.upgradable(c, c.player, e) then
			local price = levels.cost(kind, level, levels.scale(c))
			state.next = state.next or { buildings = {}, level = level + 1, factor = levels.factor(level + 1), cost = 0, topic = levels.topic(level) }
			table.insert(state.next.buildings, e)
			state.next.cost += price.credits
			for good, amount in price.materials do
				materials[good] = (materials[good] or 0) + amount
			end
			local lack = levels.lack(c, c.player, e)
			if lack == "research" or (lack == "materials" and not state.next.lack) then
				state.next.lack = lack
			end
		end
	end
	if state and state.next then
		state.next.materials = materials
		if wallet.credits(c, c.player) < state.next.cost and state.next.lack ~= "research" then
			state.next.lack = "credits"
		end
	end
	return state
end

-- Страницы сетки грузовиков, хранилищ и станций запроса (filter, reserve, request): key — выделение, для которого
-- открыта страница; deal — груз, заказ которого набирают.
local cargo: { key: string, page: string, deal: string? } = { key = "", page = "root", deal = nil }

-- Готовое и руда по порядку грузов.
local function waresOf(c): ({ string }, { string })
	local wares, ores = {}, {}
	for _, kind in goods.list(c) do
		table.insert(if kind.data.kind == "ore" then ores else wares, kind.name)
	end
	return wares, ores
end

-- Чем занят грузовик: carry, route, serve, mine, supply, pickup или auto.
local function jobOf(c, truck: number): string
	local hauler = c:get(truck, "Hauler")
	if c:has(truck, "Carry") then
		return "carry"
	elseif #hauler.route > 0 then
		return "route"
	elseif #hauler.serve > 0 then
		return "serve"
	elseif hauler.mine >= 0 then
		return "mine"
	elseif hauler.supply >= 0 then
		return "supply"
	elseif hauler.pickup >= 0 then
		return "pickup"
	end
	return "auto"
end

-- Открывает страницу для этого выделения; другое выделение — снова корень.
local function cargoPage(selection, name: string?)
	local key = table.concat(selection, ",")
	if cargo.key ~= key then
		cargo.key, cargo.page, cargo.deal = key, "root", nil
	end
	if name then
		cargo.page, cargo.deal = name, nil
	end
	return cargo.page
end

local function back(c, list, run: () -> ())
	list[BACK] = { label = c:t("common.back"), run = run }
end

-- Сетка выбранных грузовиков: верхний ряд — режим работы, подсвечен тот, в котором грузовик; ниже — что возить.
local function truckSlots(c, list, selection, units: { number })
	local page = cargoPage(selection)
	local filter = c:get(units[1], "Hauler").filter or {}
	local job = jobOf(c, units[1])
	for _, truck in units do
		if jobOf(c, truck) ~= job then
			job = "mixed"
		end
	end
	local mode = c.shared.mode
	local kind = mode and mode.kind
	if page == "root" then
		list[1] = {
			label = c:t("grid.truckAuto"),
			active = job == "auto",
			title = c:t("grid.truckAutoTip"),
			run = function()
				c:send("serve", { units = units, buildings = {} })
			end,
		}
		local carrying = kind == "carrySource" or kind == "carryTarget"
		list[2] = {
			label = c:t("grid.carry"),
			active = job == "carry" or carrying,
			title = c:t("grid.carryTip"),
			run = function()
				c.shared.truckMenu = nil
				c.shared.mode = if carrying then nil else { kind = "carrySource" }
			end,
		}
		list[3] = {
			label = if kind == "routing" then c:t("grid.routeStops", { stops = #mode.stops }) else c:t("grid.route"),
			active = job == "route" or kind == "routing",
			title = c:t("grid.routeTip"),
			run = function()
				c.shared.mode = if kind == "routing" then nil else { kind = "routing", stops = {} }
			end,
		}
		list[4] = {
			label = if kind == "serving" then c:t("grid.serveCount", { count = #mode.buildings }) else c:t("grid.serve"),
			active = job == "serve" or kind == "serving",
			title = c:t("grid.serveTip"),
			run = function()
				c.shared.mode = if kind == "serving" then nil else { kind = "serving", buildings = {} }
			end,
		}
		list[5] = {
			label = if #filter > 0 then c:t("grid.filterCount", { count = #filter }) else c:t("grid.filter"),
			active = #filter > 0,
			title = c:t("grid.filterTip"),
			run = function()
				cargoPage(selection, "filter")
			end,
		}
		if #filter > 0 then
			list[6] = { label = c:t("grid.all"), title = c:t("grid.allTip"), run = function()
				c:send("filter", { units = units, goods = {} })
			end }
		end
	elseif page == "filter" then
		local wares, ores = waresOf(c)
		-- Руда в фильтре — вся сразу: по видам её различает месторождение, а не игрок.
		local function has(names: { string }): boolean
			for _, name in names do
				if not table.find(filter, name) then
					return false
				end
			end
			return true
		end
		local function toggle(names: { string })
			local nextFilter = {}
			if has(names) then
				for _, name in filter do
					if not table.find(names, name) then
						table.insert(nextFilter, name)
					end
				end
			else
				nextFilter = table.clone(filter)
				for _, name in names do
					if not table.find(nextFilter, name) then
						table.insert(nextFilter, name)
					end
				end
			end
			c:send("filter", { units = units, goods = nextFilter })
		end
		for i, ware in wares do
			if i >= BACK - 1 then
				break
			end
			list[i] = { label = c:t(c.protos.goods[ware].data.title), picture = c.protos.goods[ware], active = has({ ware }), title = c:t("grid.carryOrNot"), run = function()
				toggle({ ware })
			end }
		end
		if #ores > 0 then
			list[math.min(#wares + 1, BACK - 1)] = { label = c:t("grid.ore"), picture = c.protos.goods[ores[1]], active = has(ores), title = c:t("grid.oreTip"), run = function()
				toggle(ores)
			end }
		end
		back(c, list, function()
			cargoPage(selection, "root")
		end)
	end
end

-- Резерв выбранных своих готовых хранилищ: сколько груза не выдавать; первое из них и наименьшая вместимость.
local function reserveSlots(c, list, selection)
	local buildings, amount, capacity = {}, 0, math.huge
	for _, e in selection do
		local stock = world.isReady(c, c.player, e) and logistics.isStore(c, e) and c:get(e, "Inventory")
		if stock then
			if #buildings == 0 then
				amount = stock.reserve or 0
			end
			table.insert(buildings, e)
			capacity = math.min(capacity, stock.capacity)
		end
	end
	if #buildings == 0 then
		return
	end
	local page = cargoPage(selection)
	local function set(value: number)
		c:send("reserve", { buildings = buildings, amount = math.max(0, math.min(capacity, value)) })
	end
	if page == "root" then
		list[1] = {
			label = if amount > 0 then c:t("grid.reserveCount", { amount = amount }) else c:t("grid.reserve"),
			active = amount > 0,
			title = c:t("grid.reserveTip"),
			run = function()
				cargoPage(selection, "reserve")
			end,
		}
	elseif page == "reserve" then
		-- Верхний ряд — прибавить, второй — убавить: по 10 и по 50.
		for i, step in { 10, 50 } do
			list[i] = { label = "+" .. step, disabled = amount >= capacity, title = c:t("grid.reserveCount", { amount = amount }), run = function()
				set(amount + step)
			end }
			list[i + 4] = { label = "−" .. step, disabled = amount <= 0, title = c:t("grid.reserveCount", { amount = amount }), run = function()
				set(amount - step)
			end }
		end
		list[3] = { label = c:t("grid.all"), active = amount >= capacity, title = c:t("grid.reserveAllTip"), run = function()
			set(capacity)
		end }
		list[CANCEL] = { label = c:t("grid.reserveNone"), active = amount <= 0, title = c:t("grid.reserveNoneTip"), run = function()
			set(0)
		end }
		back(c, list, function()
			cargoPage(selection, "root")
		end)
	end
end

-- Заказ выбранных своих станций запроса: какой груз и сколько держать; заказ первой из них и наименьшая вместимость.
local function requestSlots(c, list, selection)
	local buildings, wanted, capacity = {}, {}, math.huge
	for _, e in selection do
		local order = world.isReady(c, c.player, e) and c:get(e, "Wanted")
		local stock = order and c:get(e, "Inventory")
		if order and stock then
			if #buildings == 0 then
				wanted = order.items
			end
			table.insert(buildings, e)
			capacity = math.min(capacity, stock.capacity)
		end
	end
	if #buildings == 0 then
		return
	end
	local page = cargoPage(selection)
	local wares = waresOf(c)
	if page == "root" then
		local count = 0
		for _ in wanted do
			count += 1
		end
		list[1] = {
			label = if count > 0 then c:t("grid.requestCount", { count = count }) else c:t("grid.request"),
			active = count > 0,
			title = c:t("grid.requestTip"),
			run = function()
				cargoPage(selection, "request")
			end,
		}
	elseif page == "request" and not cargo.deal then
		-- Сначала — какой груз: ячейка на каждый, с заказанным количеством. Количество — на следующем шаге.
		for i, ware in wares do
			if i >= BACK - 1 then
				break
			end
			local amount = wanted[ware] or 0
			local title = c:t(c.protos.goods[ware].data.title)
			list[i] = { label = if amount > 0 then title .. " ×" .. amount else title, picture = c.protos.goods[ware], active = amount > 0, title = c:t("grid.requestGoodTip"), run = function()
				cargo.deal = ware
			end }
		end
		back(c, list, function()
			cargoPage(selection, "root")
		end)
	elseif page == "request" then
		-- Верхний ряд — прибавить, второй — убавить; «Всё» — сколько осталось места на складе за вычетом других заказов.
		local resource = cargo.deal :: string
		local amount = wanted[resource] or 0
		local others = 0
		for name, held in wanted do
			if name ~= resource then
				others += held
			end
		end
		local max = math.max(0, capacity - others)
		local function set(value: number)
			c:send("want", { buildings = buildings, resource = resource, amount = math.max(0, math.min(max, value)) })
		end
		local title = c:t("grid.requestAmount", { good = c:t(c.protos.goods[resource].data.title), amount = amount })
		local picture = c.protos.goods[resource]
		for i, step in { 10, 50 } do
			list[i] = { label = "+" .. step, picture = picture, disabled = amount >= max, title = title, run = function()
				set(amount + step)
			end }
			list[i + 4] = { label = "−" .. step, picture = picture, disabled = amount <= 0, title = title, run = function()
				set(amount - step)
			end }
		end
		list[3] = { label = c:t("grid.all"), active = amount >= max, title = "×" .. max, run = function()
			set(max)
		end }
		list[CANCEL] = { label = c:t("grid.requestNone"), active = amount <= 0, title = c:t("grid.requestNoneTip"), run = function()
			set(0)
		end }
		back(c, list, function()
			cargo.deal = nil
		end)
	end
end

local function slots(c, selection)
	local confirm = scuttleSlots(c, selection)
	if confirm then
		return confirm
	end
	local list = {}
	if #buildersOf(c, selection) > 0 then
		constructionSlots(c, list, selection)
	else
		page.name, page.key = "root", ""
	end
	local state = #selection == 1 and c:mine(selection[1]) and conversionOf(c, selection[1])
	if state then
		local e = selection[1]
		-- MCV разворачивают как строят: кнопка включает выбор места, он доедет туда сам.
		if not state.progress then
			local building = conversion.building(c)
			list[CONVERT] = {
				label = if state.unit then c:t("grid.deploy") else c:t("grid.pack"),
				picture = building,
				about = if state.unit then c:t(building.data.info) else nil,
				title = if state.unit then c:t("grid.deployTip") else nil,
				disabled = not state.possible,
				active = state.choosing,
				hint = state.unit and not state.traveling and (currentStep(c) or {}).deploy == true,
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
				label = c:t("grid.cancel"),
				run = function()
					c:send("cancelDeploy", { unit = e })
				end,
			}
		end
	end
	-- Свои бойцы без строителей: стойки — общая горит, если она у всех одна, — и патруль.
	if #buildersOf(c, selection) == 0 then
		local units, stance, patrolling = {}, nil, 0
		local turrets = tactics.mounts(c)
		for _, e in selection do
			if c:mine(e) and c:has(e, "Unit") and tactics.canFight(c, e, turrets[e]) then
				local own = tactics.stanceOf(c, e)
				stance = if #units == 0 or stance == own then own else ""
				table.insert(units, e)
				local state = c:get(e, "Tactics")
				if state and #state.patrol > 0 then
					patrolling += 1
				end
			end
		end
		if #units > 0 then
			for i, name in tactics.stances do
				list[i] = {
					label = c:t(STANCES[name].label),
					title = c:t(STANCES[name].tip, { leash = tactics.leash }),
					active = stance == name,
					run = function()
						c:send("stance", { units = units, stance = name })
					end,
				}
			end
			local picking = c.shared.mode ~= nil and c.shared.mode.kind == "patrolling"
			list[5] = {
				label = c:t("grid.patrol"),
				title = c:t("grid.patrolTip"),
				active = picking or patrolling > 0,
				run = function()
					c.shared.mode = if picking then nil else { kind = "patrolling", selects = true }
				end,
			}
		end
	end
	-- Свои грузовики без строителей: режим работы и что возить; хранилища — резерв, станции запроса — заказ.
	if #buildersOf(c, selection) == 0 then
		local units = truckControls.selected(c)
		if #units > 0 then
			truckSlots(c, list, selection, units)
		else
			reserveSlots(c, list, selection)
			requestSlots(c, list, selection)
		end
	end
	-- Свои производители: один или несколько зданий одного вида — заказ получает наименее занятый, очередь видна и
	-- отменяется у самого занятого.
	local producers = {}
	for _, e in selection do
		if c:has(e, "Producer") and c:mine(e) and not c:has(e, "Site") then
			table.insert(producers, e)
		end
	end
	local sameKind = #producers > 0
	for _, e in producers do
		sameKind = sameKind and (#producers == 1 or (c:has(e, "Building") and c:proto(e) == c:proto(producers[1])))
	end
	if sameKind then
		local function ordersOf(e: number): number
			local producer = c:get(e, "Producer")
			return #producer.queue + (if producer.unit ~= "" then 1 else 0)
		end
		local building, busiest = producers[1], producers[1]
		for _, e in producers do
			if ordersOf(e) < ordersOf(building) then
				building = e
			end
			if ordersOf(e) > ordersOf(busiest) then
				busiest = e
			end
		end
		local kind = c:proto(building)
		local money = wallet.credits(c, c.player)
		local orders = ordersOf(busiest)
		-- Очередь полна — заказывать некуда.
		local full = ordersOf(building) >= c.protos.mechanics.production.data.queue
		local productionLib = c.protos.mechanics.production
		local limit = productionLib.limit(c)
		local army = if limit > 0 then productionLib.army(c, c.player) else 0
		local techTree = construction.rules(c).techTree
		for _, name in kind.data.produces or {} do
			local unit = c.protos.units[name]
			if unit then
				local missing = if techTree then construction.missing(c, c.player, unit.data.requires) else {}
				local topic = if construction.researched(c, c.player, unit.data.research) then nil else research.topic(c, unit.data.research)
				local titles = {}
				for _, needed in missing do
					local other = c.protos.buildings[needed]
					table.insert(titles, if other then c:t(other.data.title) else needed)
				end
				local affordable = money >= unit.data.cost
				local capped = limit > 0 and army + (unit.data.supply or 0) > limit
				table.insert(list, {
					label = c:t(unit.data.title) or name,
					picture = unit,
					cost = unit.data.cost,
					materials = unit.data.materials,
					c = c,
					stock = (logistics.stockOf(c, c.player)),
					short = not affordable,
					unit = unit,
					disabled = not affordable or full or #missing > 0 or topic ~= nil or capped,
					title = if #missing > 0 then c:t("grid.needs", { list = table.concat(titles, ", ") })
						elseif topic then c:t("grid.needsResearch", { name = c:t(topic.data.title) })
						elseif full then c:t("grid.queueFull")
						elseif capped then c:t("grid.armyLimit", { used = army, limit = limit, supply = unit.data.supply or 0 })
						elseif not affordable then c:t("grid.noCredits")
						else nil,
					hint = (currentStep(c) or {}).unit == name,
					run = function()
						c:send("produce", { building = building, unit = name })
					end,
				})
			end
		end
		if orders > 0 and not list[CANCEL] then
			list[CANCEL] = {
				label = c:t("grid.cancelOrder"),
				title = c:t("grid.cancelOrderTip"),
				run = function()
					c:send("cancel", { building = busiest })
				end,
			}
		end
	end
	-- Своя готовая ракетная шахта: боеголовка, пуск и отмена.
	local silo = #selection == 1 and selection[1]
	local state = silo and c:mine(silo) and world.isReady(c, c.player, silo) and c:get(silo, "Silo")
	local warhead = state and c:proto(silo).data.warhead
	if state and warhead and page.name == "root" then
		local stage = if state.start >= 0 then "launching" elseif state.ready then "ready" elseif state.ticks > 0 then "assembling" else "empty"
		local lack = silos.warheadLack(c, c.player, silo)
		local aiming = c.shared.mode ~= nil and c.shared.mode.kind == "aiming" and c.shared.mode.silo == silo
		list[1] = {
			label = c:t("grid.warhead"),
			picture = c.protos.goods.rods,
			cost = if stage == "empty" then warhead.cost else nil,
			materials = if stage == "empty" then warhead.materials else nil,
			c = c,
			stock = (logistics.stockOf(c, c.player)),
			about = c:t("grid.warheadAbout"),
			active = stage ~= "empty",
			disabled = lack ~= nil,
			title = if stage ~= "empty" then c:t("grid.warheadBusy")
				elseif lack == "credits" then c:t("grid.noCredits")
				elseif lack == "materials" then c:t("grid.warheadNoMaterials")
				else c:t("grid.warheadTip", { time = clockOf(warhead.seconds) }),
			run = function()
				c:send("warhead", { silo = silo })
			end,
		}
		list[2] = {
			label = c:t("grid.launch"),
			about = c:t("grid.launchAbout"),
			active = aiming,
			disabled = stage ~= "ready" and stage ~= "launching",
			title = if stage == "launching" then c:t("grid.launchRetarget")
				elseif stage == "ready" then c:t("grid.launchTip", { seconds = warhead.launch })
				else c:t("grid.launchNoWarhead"),
			run = function()
				c.shared.mode = if aiming then nil else { kind = "aiming", silo = silo }
			end,
		}
		if stage == "assembling" then
			list[CANCEL] = { label = c:t("grid.cancel"), title = c:t("grid.cancelWarheadTip"), run = function()
				c:send("cancelWarhead", { silo = silo })
			end }
		elseif stage == "launching" then
			list[CANCEL] = { label = c:t("grid.abortLaunch"), title = c:t("grid.abortLaunchTip"), run = function()
				c:send("abortLaunch", { silo = silo })
			end }
		end
	end
	-- Свой готовый космопорт: продажа и закупка с орбиты.
	local port = #selection == 1 and selection[1]
	local trading = port and c:mine(port) and trade.isPort(c, c.player, port)
	if trading then
		tradeSlots(c, list, port)
	else
		market.port = -1
	end
	local root = page.name == "root" and (not trading or market.page == "root") and (cargo.key ~= table.concat(selection, ",") or cargo.page == "root")
	-- Свои готовые здания, которые улучшают: следующий уровень или отмена начатого.
	local raise = root and #buildersOf(c, selection) == 0 and levelState(c, selection)
	local upcoming = raise and raise.next
	if upcoming then
		local topic = research.topic(c, upcoming.topic)
		list[UPGRADE] = {
			label = c:t("grid.upgrade", { level = upcoming.level }),
			picture = c:proto(upcoming.buildings[1]),
			cost = upcoming.cost,
			materials = upcoming.materials,
			c = c,
			stock = (logistics.stockOf(c, c.player)),
			short = upcoming.lack == "credits",
			disabled = upcoming.lack ~= nil,
			title = if upcoming.lack == "research" then c:t("grid.needsResearch", { name = if topic then c:t(topic.data.title) else upcoming.topic })
				elseif upcoming.lack == "credits" then c:t("grid.noCredits")
				elseif upcoming.lack then c:t("grid.upgradeNoMaterials")
				else c:t("grid.upgradeTip", { gain = c:t(levels.GAINS[raise.gain]), factor = number(upcoming.factor) }),
			run = function()
				for _, e in upcoming.buildings do
					c:send("upgrade", { building = e, builders = {} })
				end
			end,
		}
	elseif raise and raise.raising then
		local raising = raise.raising.buildings
		list[UPGRADE] = {
			label = c:t("grid.cancel"),
			title = c:t("grid.cancelUpgradeTip"),
			run = function()
				for _, e in raising do
					c:send("cancelUpgrade", { building = e })
				end
			end,
		}
	end
	-- Своя стройка: отменить её или разбор; отменённую уже разбирают — передумать нельзя.
	local site = #selection == 1 and c:mine(selection[1]) and c:get(selection[1], "Site")
	if site and not site.undo then
		local e = selection[1]
		list[DEMOLISH] = {
			label = if site.demolish then c:t("grid.cancelDemolish") else c:t("grid.cancelBuild"),
			run = function()
				c:send("cancelBuild", { site = e })
			end,
		}
	end
	-- Готовые свои здания — разобрать за половину цены и оплаченное вперёд.
	local demolish, refund = {}, 0
	for _, e in selection do
		if construction.canDemolish(c, c.player, e) then
			table.insert(demolish, e)
			refund += construction.refundOf(kinds.of(c, e), levels.of(c, e)) + construction.prepaidOf(c, e)
		end
	end
	-- Свои готовые потребители — включить или выключить все разом (switchable): горит, если хоть один включён.
	local switchable, on = {}, false
	for _, e in selection do
		local kind = kinds.of(c, e)
		if c:mine(e) and c:has(e, "Building") and not c:has(e, "Site") and not c:has(e, "Assembly") and kind and economy.switchable(kind) then
			table.insert(switchable, e)
			on = on or not c:has(e, "Off")
		end
	end
	-- Свой цех — включить или выключить, в первой ячейке со значком изделия.
	local plant = #selection == 1 and c:mine(selection[1]) and not c:has(selection[1], "Site") and c:get(selection[1], "Assembly")
	if plant then
		local e = selection[1]
		list[1] = {
			label = if plant.on then c:t("common.turnOff") else c:t("common.turnOn"),
			picture = c.protos.goods[plant.recipe],
			lamp = plant.on,
			title = if plant.on then c:t("grid.plantOffTip") else c:t("grid.plantOnTip"),
			run = function()
				c:send("work", { building = e, on = not plant.on })
			end,
		}
	end
	if #switchable > 0 and root and not list[SWITCH] then
		list[SWITCH] = {
			label = if on then c:t("common.turnOff") else c:t("common.turnOn"),
			lamp = on,
			title = if on then c:t("grid.switchOffTip") else c:t("grid.switchOnTip"),
			run = function()
				for _, e in switchable do
					c:send("work", { building = e, on = not on })
				end
			end,
		}
	end
	-- Свои юниты среди выбранных — уничтожить; место отмены занято, только пока разворачивается MCV.
	if root and not list[CANCEL] and #defeat.giftable(c, c.player, selection) > 0 then
		list[CANCEL] = {
			label = c:t("grid.scuttle"),
			title = c:t("grid.scuttleTip"),
			run = function()
				scuttling.key = table.concat(selection, ",")
			end,
		}
	end
	if #demolish > 0 and root then
		list[DEMOLISH] = {
			label = c:t("grid.remove"),
			cost = refund,
			gain = true,
			title = c:t("grid.demolishTip"),
			run = function()
				for _, e in demolish do
					c:send("demolish", { building = e, builders = {} })
				end
			end,
		}
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
			-- Боеприпасы своих выбранных юнитов с магазинами: сколько в среднем осталось.
			if supply.enabled(c) then
				local magazines, filled = 0, 0
				for _, e in selection do
					local unit = c:has(e, "Unit") and c:mine(e) and c:proto(e)
					local capacity = if unit then supply.magazineOf(unit) else 0
					if capacity > 0 then
						magazines += 1
						filled += math.min(1, supply.ammoOf(c, e) / capacity)
					end
				end
				if magazines > 0 and filled / magazines < 1 then
					ui:text(c:t("hud.armyAmmo", { percent = percent(filled / magazines) }), { color = COLORS.soft, wrap = text })
				end
			end
			-- Машины снабжения: что в отсеках и на какой радиус раздают.
			local bays, bayCapacity, serves = 0, 0, nil
			for _, e in selection do
				local unit = c:has(e, "Unit") and c:mine(e) and c:proto(e)
				local stock = unit and unit.data.supplies and c:get(e, "Inventory")
				if stock then
					bays += math.floor(goods.amount(stock, "ammo"))
					bayCapacity += stock.capacity
					serves = unit.data.supplies
				end
			end
			if serves then
				local tone = if bays <= 0 then COLORS.warn else COLORS.soft
				stockHint(c, c:t("hud.ammo"), "ammo", bays, bayCapacity, if bays <= 0 then c:t("hud.suppliesEmpty") else c:t("hud.suppliesTip", { radius = serves.radius }), tone, text)
			end
			if site then
				local progress = math.min(1, site.progress / site.total)
				local label
				if site.demolish then
					label = if progress < 1 then c:t("hud.demolishing", { percent = percent(progress) }) else c:t("hud.waitsToDemolish")
				elseif c:has(first, "Footprint") then
					label = if c:mine(first) and construction.short(c, c.player)[first] then c:t("hud.buildingBroke", { percent = percent(progress) }) else c:t("hud.building", { percent = percent(progress) })
				else
					label = if site.blocked then c:t("hud.blocked") else c:t("hud.waitsBuilder")
				end
				widgets.bar(ui, progress, label, text)
			end
			-- Энергия: у электростанции и накопителя — их сети; генератор материи вне сети с главным зданием; подмога;
			-- нехватка; выключено.
			local built = not many and not site and kind and c:has(first, "Building")
			if built and ((kind.data.power or 0) > 0 or kind.data.battery) then
				local _, zone = economy.gridOf(c, first)
				if zone then
					local grid = gridState(zone)
					ui:text(gridText(c, grid), { color = if grid.demand > grid.produced or grid.overload then COLORS.bad else COLORS.power, wrap = text })
				end
			end
			if built and economy.coreless(c)[first] then
				ui:text(c:t("hud.coreless"), { color = COLORS.warn, wrap = text })
			end
			if built and c:mine(first) and kind.name == economy.CORE and wallet.credits(c, c.player) < economy.RELIEF_BELOW then
				ui:text(c:t("hud.relief", { below = economy.RELIEF_BELOW, income = economy.RELIEF_INCOME }), { color = COLORS.soft, wrap = text })
			end
			local starved, off = false, false
			for _, e in selection do
				if c:has(e, "Building") and not c:has(e, "Site") then
					starved = starved or economy.states(c)[e] == "starved"
					off = off or (economy.shutDown(c, c.player, e) and not c:has(e, "Assembly"))
				end
			end
			if starved then
				ui:text(c:t("hud.starved"), { color = COLORS.bad, wrap = text })
			end
			local switchedOn = false
			for _, e in selection do
				if c:mine(e) and c:has(e, "Building") and not c:has(e, "Site") and not c:has(e, "Off") and not c:has(e, "Assembly") and economy.switchable(kinds.of(c, e)) then
					switchedOn = true
				end
			end
			if off and not switchedOn then
				ui:text(c:t("hud.switchedOff"), { color = COLORS.warn, wrap = text })
			end
			-- Своё повреждённое: сколько стоит починка (у стройки прочность — та же доля, что полоса стройки).
			local health = not many and not site and c:mine(first) and c:get(first, "Health")
			if health and health.value < health.max and construction.isRepairable(c, first) then
				local repair = construction.repairCostOf(kind.data.cost, health.value, construction.rules(c).repairCost, health.max)
				ui:text(c:t("hud.health", { percent = percent(health.value / health.max), repair = repair }), { color = COLORS.soft, wrap = text })
			end
			-- Генератор щита: запас купола или когда он поднимется.
			local dome = not many and built and kind.data.shield
			local shield = dome and c:get(first, "Shield")
			if shield then
				local down = math.max(0, math.ceil((shield.down - c.tick) * c.step))
				ui:text(if down > 0 then c:t("hud.shieldDown", { seconds = down }) else c:t("hud.shield", { charge = math.floor(shield.charge), capacity = dome.capacity }), { color = COLORS.soft, wrap = text })
			end
			-- Склад здания, кузов грузовика и его работа, остаток месторождения под шахтой.
			local stock = not many and c:mine(first) and c:get(first, "Inventory")
			local hauler = not many and c:get(first, "Hauler")
			if stock and hauler then
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					local before, after = widgets.split(c:t("hud.cargo", { capacity = stock.capacity }), "items")
					ui:text((string.gsub(before, "%s+$", "")))
					goodsRow(c, stock.items, c:t("common.empty"))
					ui:text((string.gsub(after, "^%s*(.-)[%s%.]*$", "%1")))
				end)
				local job
				local order = c:get(first, "Carry")
				local function titleOf(e: number): string
					local kind = c:alive(e) and c:proto(e)
					return if kind then c:t(kind.data.title) else "?"
				end
				local function goodName(name: string): string
					local kind = c.protos.goods[name]
					return if kind then c:t(kind.data.title) else name
				end
				if order then
					local left = math.ceil(order.left - 1e-6)
					job = if order.from >= 0
						then c:t("hud.job.carry", { name = goodName(order.resource), from = titleOf(order.from), to = titleOf(order.to), left = left })
						else c:t("hud.job.unload", { name = goodName(order.resource), to = titleOf(order.to), left = left })
				elseif #hauler.route > 0 then
					local names = {}
					for _, stop in hauler.route do
						table.insert(names, titleOf(stop))
					end
					job = c:t("hud.job.route", { stops = table.concat(names, " → ") })
				elseif #hauler.serve > 0 then
					local names = {}
					for _, building in hauler.serve do
						table.insert(names, titleOf(building))
					end
					job = c:t("hud.job.serve", { list = table.concat(names, ", ") })
				elseif hauler.supply >= 0 then
					job = c:t("hud.job.supply", { name = titleOf(hauler.supply) })
				elseif hauler.mine >= 0 then
					job = c:t("hud.job.mine")
				elseif hauler.pickup >= 0 then
					job = c:t("hud.job.pickup")
				elseif hauler.to >= 0 and c:alive(hauler.to) then
					local kind = c.protos.goods[hauler.resource]
					local name = if kind then c:t(kind.data.title) else hauler.resource
					local left = math.floor(math.max(0, if hauler.full then goods.amount(stock, hauler.resource) else hauler.amount))
					local toKind = c:proto(hauler.to)
					local fromKind = hauler.from >= 0 and c:alive(hauler.from) and c:proto(hauler.from)
					job = if fromKind and not hauler.full
						then c:t("hud.job.carry", { name = name, from = c:t(fromKind.data.title), to = c:t(toKind.data.title), left = left })
						else c:t("hud.job.unload", { name = name, to = c:t(toKind.data.title), left = left })
				else
					job = c:t("hud.job.auto")
				end
				ui:text(job, { color = COLORS.soft, wrap = text })
			elseif stock and built and kind.data.ammo then
				-- У турели на складе только боеприпасы.
				local have = math.floor(goods.amount(stock, "ammo"))
				local tone = if have <= 0 then COLORS.warn else COLORS.soft
				stockHint(c, c:t("hud.ammo"), "ammo", have, stock.capacity, if have <= 0 then c:t("hud.ammoEmpty") else c:t("hud.ammoTip"), tone, text)
			elseif stock and built then
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					ui:text((if kind.data.stores then c:t("hud.storage") else c:t("hud.stock")) .. ":")
					goodsRow(c, stock.items, c:t("common.empty"))
					ui:text((string.gsub(c:t("hud.holds", { capacity = stock.capacity }), "^%s+", "")) .. (if (stock.reserve or 0) > 0 then c:t("hud.reserve", { amount = stock.reserve }) else ""), { color = COLORS.dim })
				end)
			end
			-- Реактор: сколько стержней и горит ли стержень.
			local burns = built and kind.data.burns
			if stock and built and burns then
				local have = math.floor(goods.amount(stock, burns.good))
				local burning = economy.burning(c, first)
				local tone = if have <= 0 and not burning then COLORS.warn else COLORS.soft
				stockHint(c, c:t("hud.rods"), burns.good, have, stock.capacity, if burning then c:t("hud.rodsTip") else c:t("hud.rodsEmpty"), tone, text)
			end
			-- Уровень здания и как идёт улучшение.
			local raise = built and levelState(c, selection)
			if raise then
				ui:text(if raise.level > 1 then c:t("hud.level", { level = raise.level, max = levels.MAX_LEVEL, gain = c:t(levels.GAINS[raise.gain]), factor = number(raise.factor) }) else c:t("hud.levelBase", { level = raise.level, max = levels.MAX_LEVEL }), { color = COLORS.soft, wrap = text })
				if raise.raising then
					local progress = raise.raising.progress
					widgets.bar(ui, progress, if progress > 0 then c:t("hud.upgrading", { percent = percent(progress) }) else c:t("hud.waitsToUpgrade"), text)
				end
			end
			-- Ракетная шахта: сборка боеголовки, готова, пуск.
			local silo = built and c:mine(first) and kind.data.warhead and c:get(first, "Silo")
			if silo then
				if silo.start >= 0 then
					local left = math.max(0, silo.start + math.floor(kind.data.warhead.launch / c.step + 0.5) - c.tick)
					ui:text(c:t("hud.launching", { seconds = math.ceil(left * c.step) }), { color = COLORS.warn, wrap = text })
				elseif silo.ticks > 0 and not silo.ready then
					local progress = math.min(1, silo.progress / silo.ticks)
					widgets.bar(ui, progress, c:t("hud.warheadAssembling", { percent = percent(progress) }), text)
				else
					ui:text(if silo.ready then c:t("hud.warheadReady") else c:t("hud.warheadEmpty"), { color = COLORS.soft, wrap = text })
				end
			end
			-- Перехватчик: сколько ракет, собирает ли следующую и что мешает.
			local guard = built and c:mine(first) and kind.data.intercept
			local charge = guard and c:get(first, "Interceptor")
			if charge then
				local count, capacity = charge.missiles, guard.capacity
				if charge.ticks > 0 then
					local progress = math.min(1, charge.progress / charge.ticks)
					widgets.bar(ui, progress, c:t("hud.interceptorAssembling", { count = count, capacity = capacity, percent = percent(progress) }), text)
				else
					local lack = silos.interceptorLack(c, first)
					local list = {}
					for _, name in goods.names(c) do
						local amount = guard.materials[name]
						if amount then
							table.insert(list, amount .. " " .. c:t(c.protos.goods[name].data.title))
						end
					end
					ui:text(if lack == "off" then c:t("hud.interceptorOff", { count = count, capacity = capacity })
						elseif lack == "credits" then c:t("hud.interceptorNoCredits", { count = count, capacity = capacity, cost = guard.cost })
						elseif lack == "materials" then c:t("hud.interceptorNoMaterials", { count = count, capacity = capacity, materials = table.concat(list, ", ") })
						else c:t("hud.interceptorReady", { count = count, capacity = capacity, radius = guard.radius }), { color = COLORS.soft, wrap = text })
				end
			end
			-- Космопорт: рейс, набираемая сделка или что тут можно.
			if built and c:mine(first) and trade.isPort(c, c.player, first) then
				local order = c:get(first, "Trade")
				if order then
					local name = c:t(c.protos.goods[order.resource].data.title)
					local wanted = math.floor(order.wanted + 0.5)
					local label, progress
					if order.buy then
						progress = 1 - order.left / order.total
						label = c:t("hud.buying", { name = name, wanted = wanted, paid = wanted * trade.buyPrice(c, order.resource) })
					elseif order.total > 0 then
						progress = 1 - order.left / order.total
						label = c:t("hud.shipping", { name = name, wanted = wanted, total = wanted * trade.price(c, order.resource) })
					else
						local delivered = math.floor(trade.delivered(c, first))
						progress = delivered / order.wanted
						label = c:t("hud.hauling", { name = name, delivered = delivered, wanted = wanted })
					end
					widgets.bar(ui, progress, label, text)
				else
					local buying = market.page == "buy"
					local deal = market.port == first and (market.page == "sell" or buying) and market.deal and dealOf(c, first, buying, market.deal)
					if deal then
						ui:box({ direction = "row", align = "center", gap = 6 }, function()
							ui:text((if buying then c:t("grid.buy") else c:t("grid.sell")) .. ":", { color = COLORS.soft })
							goodWith(c, deal.resource, deal.amount, 20)
							local field = ui:input("deal", tostring(deal.amount), { width = 72, digits = true, maxLength = 6 })
							local amount = math.max(0, math.min(deal.max, math.floor(tonumber(field.value) or 0)))
							if amount ~= deal.amount then
								market.deal = { resource = deal.resource, amount = amount }
							end
							if table.find(field.keys, "Enter") and amount >= 1 then
								c:send(if buying then "buy" else "sell", { port = first, resource = deal.resource, amount = amount })
								market.deal = nil
							end
						end)
						-- В словаре это продолжение строки сделки (« — цена …»): здесь оно со своей строки.
						local note = if buying
							then c:t("hud.dealBuy", { total = deal.amount * deal.price, room = deal.room - deal.amount })
							else c:t("hud.dealSell", { total = deal.amount * deal.price, left = deal.max - deal.amount })
						ui:text(widgets.capital((string.gsub(note, "^[%s—]+", ""))), { color = COLORS.soft, wrap = text })
					else
						ui:text((if #offersOf(c, first) > 0
							then c:t("hud.sellHint")
							else c:t("hud.nothingToSell")) .. c:t("hud.buyHint"), { color = COLORS.soft, wrap = text })
					end
				end
			end
			if built and kind.data.extract then
				local deposit = logistics.depositUnder(c, first)
				local depositKind = deposit and c:proto(deposit)
				local ore = depositKind and c.protos.goods[goods.oreOf(c, depositKind.name) or ""]
				if deposit and ore then
					local left = c:get(deposit, "Deposit").reserve
					ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
						goodWith(c, ore.name, nil, 20)
						local line = c:t("hud.depositLeft", { name = c:t(ore.data.title), left = if left > 0 then c:t("hud.left", { amount = math.floor(left) }) else c:t("hud.depositDepleted") })
						local _, after = widgets.split(line, "icon")
						ui:text((string.gsub(after, "^%s+", "")), { color = COLORS.soft })
					end)
				end
			end
			-- Лаборатория: что ведут и почему стоит.
			local lab = built and c:mine(first) and c:get(first, "Research")
			if lab then
				local topic = research.current(c, c.player)
				local state = research.player(c, c.player)
				if not topic then
					ui:text(c:t("hud.researchIdle"), { color = COLORS.soft, wrap = text })
				else
					local progress = (state and state.progress or {})[topic] or 0
					widgets.bar(ui, progress, c:t("hud.researching", { name = c:t(research.topic(c, topic).data.title), percent = percent(progress) }), text)
					if lab.lack ~= "off" then
						local goodKind = c.protos.goods[lab.lack]
						local message = if lab.lack == "power" then c:t("hud.labNoPower")
							elseif lab.lack == "credits" then c:t("hud.labNoCredits")
							elseif goodKind then c:t("hud.labLacks", { name = c:t(goodKind.data.title) })
							else c:t("hud.labSpeed", { speed = lab.speed })
						ui:text(message, { color = if lab.lack ~= "" and lab.lack ~= "idle" then COLORS.warn else COLORS.soft, wrap = text })
					end
				end
			end
			-- Материалы стройки и первого заказа: сколько есть из нужного; ждут — подвоз.
			local materials = not many and c:mine(first) and logistics.materials(c, first)
			if materials then
				local have = c:get(first, "Inventory")
				local waiting = if site then construction.awaitsMaterials(c, first) else next(logistics.missing(c, first)) ~= nil
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					ui:text(c:t("hud.materials") .. ":", { color = if waiting then COLORS.warn else COLORS.soft })
					for _, name in goods.names(c) do
						if materials[name] then
							goodWith(c, name, if have then goods.amount(have, name) else 0, 20, materials[name])
						end
					end
				end)
				if waiting then
					ui:text(widgets.capital((string.gsub(c:t("hud.materialsWaiting"), "^[%s—]+", ""))), { color = COLORS.warn, wrap = text })
				end
			end
			-- Цех: рецепт, сколько изделия у зоны и что он делает.
			local assembly = built and c:mine(first) and c:get(first, "Assembly")
			local product = assembly and c.protos.goods[assembly.recipe]
			if assembly and product then
				local seconds = 0
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					for _, name in goods.names(c) do
						seconds += product.data.recipe[name] or 0
					end
					-- «{inputs} → {output} за {seconds} с»: на месте подстановок — значки.
					local before, rest = widgets.split(c:t("hud.recipe", { seconds = seconds }), "inputs")
					local middle, after = widgets.split(rest, "output")
					if string.find(before, "%S") then
						ui:text((string.gsub(before, "^%s*(.-)%s*$", "%1")), { color = COLORS.dim })
					end
					for _, name in goods.names(c) do
						local amount = product.data.recipe[name]
						if amount then
							goodWith(c, name, amount, 20)
						end
					end
					ui:text((string.gsub(middle, "^%s*(.-)%s*$", "%1")))
					goodWith(c, product.name, product.data.yield, 20)
					ui:text((string.gsub(after, "^%s*(.-)%s*$", "%1")), { color = COLORS.dim })
				end)
				local zoneStock = 0
				local network = logistics.networkOf(c, first)
				for _, member in (if network then network.members else { first }) do
					local held = c:get(member, "Inventory")
					if held and (logistics.isStore(c, member) or c:has(member, "Assembly")) then
						zoneStock += goods.amount(held, product.name)
					end
				end
				for _, truck in c:each({ "Hauler", "Inventory", "Owner" }) do
					if c:mine(truck) then
						zoneStock += goods.amount(c:get(truck, "Inventory"), product.name)
					end
				end
				local held = c:get(first, "Inventory")
				local full = held and goods.room(held, product.name) < product.data.yield
				local phase = if not assembly.on then (if assembly.progress > 0 then c:t("hud.assemblyStates.offFinishing") else c:t("hud.assemblyStates.off")) elseif assembly.progress > 0 then c:t("hud.assemblyStates.working") elseif full then c:t("hud.assemblyStates.full") else c:t("hud.assemblyStates.waiting")
				widgets.bar(ui, assembly.progress / math.max(seconds, 1e-9), c:t("hud.assembly", { name = c:t(product.data.title), have = math.floor(zoneStock), state = phase }), text)
				if not assembly.on then
					ui:text(c:t("hud.plantOff"), { color = COLORS.warn, wrap = text })
				end
			end
			local cell = built and c:get(first, "Accumulator")
			if cell and kind.data.battery then
				local flow = math.round(cell.flow * 100) / 100
				local charge, capacity = math.floor(cell.charge), kind.data.battery.capacity
				ui:text(if flow > 0 then c:t("hud.batteryGiving", { charge = charge, capacity = capacity, flow = number(flow) }) elseif flow < 0 then c:t("hud.batteryCharging", { charge = charge, capacity = capacity, flow = number(-flow) }) else c:t("hud.battery", { charge = charge, capacity = capacity }), { color = COLORS.soft, wrap = text })
			end
			local state = not many and c:mine(first) and conversionOf(c, first)
			if state and state.progress then
				widgets.bar(ui, state.progress, if state.blocked then c:t("hud.blocked") elseif state.unit then c:t("hud.deploying") else c:t("hud.packing"), text)
			end
			local producer = not many and c:get(first, "Producer")
			local packed = producer and c:has(first, "Unit")
			if producer then
				if producer.unit ~= "" then
					local unit = c.protos.units[producer.unit]
					widgets.bar(ui, producer.progress / (unit.data.buildTime or 1), c:t(unit.data.title) or producer.unit, text)
					ui:box({ direction = "row", gap = 4 }, function()
						for i, name in { producer.unit, table.unpack(producer.queue) } do
							ui:box({ id = "queue:" .. i, width = 32, height = 32, skin = "well", padding = 4 }, function()
								ui:image(c.protos.units[name], QUEUED, QUEUED)
							end)
						end
					end)
				end
				if packed and producer.unit ~= "" then
					ui:text(c:t("hud.packedQueue"), { color = COLORS.soft, wrap = text })
				end
				-- Армия: сколько места в лимите занято (hud.army).
				local productionLib = c.protos.mechanics.production
				local limit = productionLib.limit(c)
				if limit > 0 then
					ui:text(c:t("hud.army", { used = productionLib.army(c, c.player), limit = limit }), { color = COLORS.soft, wrap = text })
				end
				if not packed then
					ui:text(if producer.rally then c:t("hud.rallySet") else c:t("hud.rallyTip"), { color = COLORS.soft, wrap = text })
				end
			end
			local mode = c.shared.mode
			if #buildersOf(c, selection) > 0 and not (mode and mode.kind == "placing") then
				ui:text(c:t("hud.builderTip"), { color = COLORS.soft, wrap = text })
			end
			if state and state.unit and not state.progress and not state.choosing then
				ui:text(if state.traveling then c:t("hud.deployTravel") else c:t("hud.mcvTip"), { color = COLORS.soft, wrap = text })
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

-- Режимы наведения: название и что делать — ключи словаря; у покрытия название — сам инструмент.
local MODES = {
	deploying = { name = "mode.deploying", tip = "mode.tips.deploying" },
	patrolling = { name = "mode.patrolling", tip = "mode.tips.patrolling" },
	aiming = { name = "mode.aiming", tip = "mode.tips.aiming" },
	placing = { name = "mode.placing", tip = "mode.tips.placing" },
	paving = { name = "{name}", tip = "mode.tips.pavingStart" },
	routing = { name = "mode.routing", tip = "mode.tips.routing", done = true },
	serving = { name = "mode.serving", tip = "mode.tips.serving", done = true },
	carrySource = { name = "mode.carrySource", tip = "mode.tips.carrySource" },
	carryTarget = { name = "mode.carryTarget", tip = "mode.tips.carryTarget" },
}


-- Полоса режима над полем: какой режим, что делать дальше и как выйти. Esc и правая кнопка работают и так, но на
-- сенсорном экране их нет.
local function modeBar(c)
	local mode = c.shared.mode
	local spec = mode and MODES[mode.kind]
	if not spec then
		return
	end
	local ui = c.ui
	-- Справа — «Первые шаги», слева — уведомления: середина не наезжает на них.
	local room = if stepsShown(c) and ui.width >= NARROW then math.min(ui.width - 24, math.max(280, ui.width - 2 * 324)) else ui.width - 24
	ui:box({ anchor = { centerX = 0, top = TOP_HEIGHT + 6 } }, function()
		ui:box({ id = "mode", skin = "panel", padding = { 10, 12, 10, 16 }, direction = "row", align = "center", gap = 12, maxWidth = room }, function()
			local building = mode.building and c.protos.buildings[mode.building]
			local name = building and c:t(building.data.title) or ""
			local tip = c:t(spec.tip)
			if mode.kind == "paving" then
				local tool = c.protos.buildings[mode.tool]
				name = c:t(TOOL_NAMES[mode.tool]) or (tool and c:t(tool.data.title)) or mode.tool
				local shown = c.shared.paving
				if shown and shown.tiles > 0 then
					tip = c:t("mode.tips.paving", { tiles = shown.tiles, cost = shown.cost })
					if (shown.short or 0) > 0 then
						tip ..= c:t("mode.tips.pavingShort", { short = shown.short })
					end
				elseif mode.tool == "remove" then
					tip = c:t("mode.tips.remove")
				end
			end
			if mode.kind == "routing" then
				tip = c:t(spec.tip, { stops = #mode.stops })
			elseif mode.kind == "serving" then
				tip = c:t(spec.tip, { count = #mode.buildings })
			elseif mode.kind == "carryTarget" then
				local good = c.protos.goods[mode.resource]
				tip = c:t(spec.tip, { name = if good then c:t(good.data.title) else mode.resource, amount = mode.amount })
			end
			ui:text(c:t(spec.name, { name = name }), { color = COLORS.team })
			ui:text(tip, { color = COLORS.soft, wrap = math.max(160, room - 320) })
			-- Набор маршрута и обслуживания кончается «Готово»: набранное уходит грузовикам.
			if spec.done then
				if ui:button("mode:done", { height = 32, padding = { 2, 14 }, skin = "button-primary" }, function()
					ui:text(c:t("mode.done"), shadow())
				end) then
					truckControls.finish(c)
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

-- Остаток, каким игрок видел месторождение в последний раз: пока видит хоть тайл — настоящий, в тумане — прежний; так
-- туман не выдаёт, копают ли его чужие. Ключ — сущность месторождения.
local seenReserve: { [number]: number } = {}

local function knownReserve(c, e: number, x: number, y: number): number?
	for dy = 0, depositsLib.SIZE - 1 do
		for dx = 0, depositsLib.SIZE - 1 do
			if c:sees(x + dx + 0.5, y + dy + 0.5) then
				local left = c:get(e, "Deposit").reserve
				seenReserve[e] = left
				return left
			end
		end
	end
	return seenReserve[e]
end

-- Что выйдет из месторождения и через что: «Металлическая руда → Плавильня → Металл».
local function chainOf(c, resource: string): string
	local ore = goods.oreOf(c, resource)
	local refinery = "?"
	for _, kind in construction.menu(c) do
		if ore and kind.data.refines == ore then
			refinery = c:t(kind.data.title)
			break
		end
	end
	local function title(name: string?): string
		local kind = name and c.protos.goods[name]
		return if kind then c:t(kind.data.title) else "?"
	end
	return title(ore) .. " → " .. refinery .. " → " .. title(resource)
end

-- Подсказки у указателя над картой: месторождение — какое, сколько осталось и что из него выйдет; своя труба или
-- колодец — сколько зданий в сети и что в её хранилищах.
local function hoverTips(c)
	local input = c.input
	if not input.inside or input.over_ui then
		return
	end
	local ui = c.ui
	local anchor = if input.x > ui.width - 260 then { right = ui.width - input.x + 16, top = input.y + 16 } else { left = input.x + 16, top = input.y + 16 }
	local tileX, tileY = math.floor(input.wx), math.floor(input.wy)
	-- Месторождение занимает SIZE × SIZE тайлов: подходит то, что накрывает тайл под указателем.
	local half = depositsLib.SIZE / 2
	for _, e in c:each({ "Deposit", "Position" }) do
		local at = c:get(e, "Position")
		local x, y = at.x - half, at.y - half
		if tileX >= x and tileX < x + depositsLib.SIZE and tileY >= y and tileY < y + depositsLib.SIZE and c:knows(e) then
			local kind = c:proto(e)
			local resource = kind and kind.name
			local good = resource and c.protos.goods[resource]
			if not good then
				return
			end
			local left = knownReserve(c, e, x, y)
			ui:box({ anchor = anchor, skin = "panel", padding = { 8, 12 }, direction = "column", gap = 2, passive = true }, function()
				ui:box({ direction = "row", align = "center", gap = 6 }, function()
					ui:image(good, 20, 20)
					ui:text(c:t("hud.depositTip", { name = c:t(good.data.title) }))
					ui:text(if left == nil then c:t("hud.leftUnknown") elseif left > 0 then c:t("hud.left", { amount = math.floor(left) }) else c:t("hud.depleted"), { color = COLORS.dim })
				end)
				ui:text(chainOf(c, resource), { color = COLORS.dim, wrap = 300 })
			end)
			return
		end
	end
	local e = c:occupant(tileX, tileY)
	local kind = e and c:mine(e) and c:proto(e)
	if not kind or not kind.data.pipe then
		return
	end
	local network = logistics.networkOf(c, e)
	if not network then
		return
	end
	local buildings, items, capacity = 0, {}, 0
	for _, member in network.members do
		local other = c:proto(member)
		if other and not other.data.pipe then
			buildings += 1
		end
		if logistics.isStore(c, member) and world.isReady(c, c.player, member) then
			local stock = c:get(member, "Inventory")
			if stock then
				capacity += stock.capacity
				for name, amount in stock.items do
					items[name] = (items[name] or 0) + amount
				end
			end
		end
	end
	ui:box({ anchor = anchor, skin = "panel", padding = { 8, 12 }, direction = "row", align = "center", gap = 6, passive = true }, function()
		ui:text(c:t("hud.network", { buildings = buildings }))
		goodsRow(c, items, if capacity > 0 then c:t("hud.storesEmpty") else c:t("hud.noStores"))
	end)
end

-- Сколько груза за щелчок «±» в окне приказа.
local CARRY_STEP = 10
-- Что выбрано в окне приказа: здание, груз и сколько.
local picked: { building: number, resource: string, amount: number }? = nil

-- Окно приказа выбранным грузовикам по зданию: что оттуда взять и сколько, что выгрузить туда из кузовов, возить ли
-- руду отсюда, обеспечивать ли его.
local function truckMenu(c)
	local building = c.shared.truckMenu
	if not building or not c:alive(building) then
		picked = nil
		return
	end
	local ui = c.ui
	local units = truckControls.selected(c)
	local stock = c:get(building, "Inventory")
	if #units == 0 or not stock then
		return
	end
	local take, unload, capacity = {}, {}, 0
	for _, name in goods.names(c) do
		local amount = math.floor(logistics.spare(c, building, name) + 1e-9)
		if amount >= 1 then
			table.insert(take, { resource = name, amount = amount })
		end
	end
	local loaded = {}
	for _, truck in units do
		local hold = c:get(truck, "Inventory")
		if hold then
			capacity += hold.capacity
			for _, name in goods.names(c) do
				local amount = goods.amount(hold, name)
				if amount > goods.EPSILON and truckControls.isCarryTarget(c, building, name) then
					loaded[name] = (loaded[name] or 0) + amount
				end
			end
		end
	end
	for _, name in goods.names(c) do
		if loaded[name] then
			table.insert(unload, { resource = name, amount = loaded[name] })
		end
	end
	local mine = world.isReady(c, c.player, building) and logistics.dataOf(c, building).extract == true
	local needy = logistics.canSupply(c, c.player, building)
	if picked and picked.building ~= building then
		picked = nil
	end
	local chosen = picked
	local available = 0
	for _, item in take do
		if chosen and item.resource == chosen.resource then
			available = item.amount
		end
	end
	local amount = if chosen then math.max(1, math.min(available, chosen.amount)) else 0
	local kind = c:proto(building)
	local function close()
		c.shared.truckMenu = nil
		picked = nil
	end
	local function order(name: string, args)
		c:send(name, args)
		c:sound("order", { volume = 0.35 })
		close()
	end
	if c.input.hits.escape then
		close()
		return
	end
	local width = math.min(440, ui.width - 24)
	ui:box({ id = "truck:backdrop", anchor = { left = 0, right = 0, top = 0, bottom = 0 }, background = "rgb(0 0 0 / 0.35)" })
	if ui:clicked("truck:backdrop") then
		close()
		return
	end
	local function list(items, prefix: string, pick: (string, number) -> (), active: string?)
		ui:box({ direction = "column", gap = 4, align = "stretch" }, function()
			for _, item in items do
				if ui:button(prefix .. ":" .. item.resource, { height = 36, padding = { 0, 10 }, justify = "start", gap = 8, active = active == item.resource }, function()
					goodWith(c, item.resource, item.amount)
					ui:text(c:t(c.protos.goods[item.resource].data.title), shadow())
				end) then
					pick(item.resource, item.amount)
				end
			end
		end)
	end
	ui:box({ id = "truck", anchor = { centerX = 0, centerY = 0 }, width = width, maxHeight = ui.height - 24, skin = "panel", padding = { 16, 18 }, direction = "column", gap = 10, align = "stretch" }, function()
		ui:box({ direction = "row", align = "center", gap = 8 }, function()
			ui:box({ grow = 1 }, function()
				ui:text(c:t("truck.title", { name = if kind then c:t(kind.data.title) else "" }), { color = COLORS.bright, wrap = width - 90 })
			end)
			if ui:button("truck:close", { height = 36, padding = { 0, 10 } }, function()
				ui:text("✕", shadow())
			end) then
				close()
			end
			ui:tip("truck:close", c:t("truck.closeTip"))
		end)
		if #take > 0 then
			ui:box({ direction = "column", gap = 6, align = "stretch" }, function()
				ui:text(c:t("truck.take"), { color = COLORS.soft })
				list(take, "truck:take", function(resource: string, have: number)
					picked = { building = building, resource = resource, amount = have }
				end, chosen and chosen.resource)
				if chosen and available >= 1 then
					ui:box({ direction = "row", align = "center", gap = 4 }, function()
						if ui:button("truck:less", { height = 36, padding = { 0, 10 }, disabled = amount <= 1 }, function()
							ui:text("−" .. CARRY_STEP, shadow())
						end) then
							picked = { building = building, resource = chosen.resource, amount = math.max(1, amount - CARRY_STEP) }
						end
						ui:box({ minWidth = 56, direction = "row", justify = "center" }, function()
							goodWith(c, chosen.resource, amount)
						end)
						if ui:button("truck:more", { height = 36, padding = { 0, 10 }, disabled = amount >= available }, function()
							ui:text("+" .. CARRY_STEP, shadow())
						end) then
							picked = { building = building, resource = chosen.resource, amount = math.min(available, amount + CARRY_STEP) }
						end
						if ui:button("truck:all", { height = 36, padding = { 0, 10 }, active = amount >= available }, function()
							ui:text(c:t("grid.all"), shadow())
						end) then
							picked = { building = building, resource = chosen.resource, amount = available }
						end
						if ui:button("truck:where", { height = 36, padding = { 0, 10 }, skin = "button-primary" }, function()
							ui:text(c:t("truck.where"), shadow())
						end) then
							c.shared.mode = { kind = "carryTarget", from = building, resource = chosen.resource, amount = amount }
							close()
						end
						ui:tip("truck:where", c:t("truck.whereTip", { capacity = capacity }))
					end)
				end
			end)
		end
		if #unload > 0 then
			ui:box({ direction = "column", gap = 6, align = "stretch" }, function()
				ui:text(c:t("truck.unload"), { color = COLORS.soft })
				list(unload, "truck:unload", function(resource: string, have: number)
					order("carry", { units = units, from = -1, to = building, resource = resource, amount = have })
				end)
			end)
		end
		if mine or needy then
			ui:box({ direction = "column", gap = 6, align = "stretch" }, function()
				if mine and ui:button("truck:mine", { height = 36, padding = { 0, 10 }, justify = "start" }, function()
					ui:text(c:t("truck.mine"), shadow())
				end) then
					order("haul", { units = units, mine = building })
				end
				if needy and ui:button("truck:supply", { height = 36, padding = { 0, 10 }, justify = "start" }, function()
					ui:text(c:t("truck.supply"), shadow())
				end) then
					order("supply", { units = units, target = building })
				end
			end)
		end
		if #take == 0 and #unload == 0 and not mine and not needy then
			ui:text(c:t("truck.nothing"), { color = COLORS.soft, wrap = width - 36 })
		end
	end)
end

function hud.draw(c)
	-- Видимая часть карты — между верхней полосой и нижней панелью (inset камеры): у её краёв едет камера за рамкой.
	c.shared.inset = { top = TOP_HEIGHT, bottom = INNER + 16, left = 0, right = 0 }
	shownAlerts = alertsLib.update(c)
	alertList(c)
	stepsPanel(c)
	modeBar(c)
	rewards(c)
	topBar(c)
	hoverTips(c)
	bottomBar(c)
	truckMenu(c)
end

return hud
