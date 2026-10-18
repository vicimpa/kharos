--!strict
-- Панель игрока — перенос packages/client/src/gui/hud.ts (верхняя полоса) и gui/bar.ts (нижняя: мини-карта,
-- сведения о выбранном, сетка команд 4 × 3). Те же размеры, рамки скина, шрифты и цвета.

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

local clockOf = widgets.clock
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
-- Постоянные места сетки: превращение, отмена, разбор и «Назад» (CONVERT, CANCEL, DEMOLISH, BACK в commands.ts);
-- выключатель — на месте «Назад» (SWITCH).
local CONVERT, CANCEL, DEMOLISH, BACK = 9, 10, 11, 12
-- Улучшение здания: конец второго ряда корня — у зданий, которые улучшают, списков там нет (UPGRADE).
local UPGRADE = 8
local SWITCH = BACK
-- Названия инструментов протяжки: стена и ворота — как здание (toolName).
local TOOL_NAMES = { pipe = "Труба", well = "Колодцы", foundation = paving.TITLES.foundation, road = paving.TITLES.road, remove = paving.TITLES.remove }
-- Инструменты раздела «Покрытие» и их подсказки (PAVE_TOOLS, grid.toolTips в commands.ts).
local PAVE_TOOLS = { "foundation", "road" }
local PAVE_TIPS = {
	foundation = "Здания на нём строятся вдвое быстрее, на песке он разрешает стройку. Кладётся и под свои здания, и вместо своей дороги. Взрывы его разбивают. Тяни мышью прямоугольник",
	road = "Наземные едут быстрее; по болоту — мост за " .. paving.BRIDGE_COST .. " за тайл. На дороге не строят; кладётся и вместо своего фундамента. Тяни мышью линию",
}
-- С какой доли выработки полная нагрузка сети уже тесна: число энергии на полосе желтеет (GRID_TIGHT).
local GRID_TIGHT = 0.8
-- Разделы строителя: в какой странице какое здание; остальное — хозяйство (SECTIONS в commands.ts). Раздел — с
-- картинкой здания, по порядку кнопок.
local SECTIONS = {
	{ page = "economy", label = "Хозяйство", tip = "Энергия, добыча, лаборатория и торговля", picture = "generator" },
	{ page = "storage", label = "Склады", tip = "Хранилища ресурсов и изделий", picture = "metalYard", list = { "metalYard", "siliconStore", "fuelTank", "khariteVault", "lithiumStore", "uraniumCask", "blockYard", "ammoBunker", "partsLocker", "rodRack", "requestStation" } },
	{ page = "industry", label = "Переработка", tip = "Переработка руды в ресурсы", picture = "smelter", list = { "smelter", "siliconWorks", "distillery", "enricher", "evaporator", "uraniumMill" } },
	{ page = "production", label = "Производство", tip = "Заводы изделий: стройблоки, боеприпасы, компоненты и стержни", picture = "blockPlant", list = { "blockPlant", "ammoPlant", "partsPlant", "rodPlant" } },
	{ page = "military", label = "Военное", tip = "Казармы, машинный завод, аэродром, ремонтная станция, станция поставки и ракетная шахта", picture = "factory", list = { "barracks", "factory", "airfield", "repairStation", "supplyDepot", "silo" } },
	{ page = "defense", label = "Оборона", tip = "Стены, турели, щит, перехватчик ядерных ракет и радар", picture = "wall", list = { "wall", "gate", "turret", "rocketTurret", "cannonTurret", "laserTurret", "arcTurret", "shieldGenerator", "interceptor", "radar" } },
}

-- Стойки бойцов: подпись и подсказка (grid.stances и grid.stanceTips в ru.json).
local STANCES = {
	aggressive = { label = "Агрессивно", tip = "Идти на любого врага, которого видно, и гнаться за ним; посланные идти бьют по дороге тех, кто опасен, и идут дальше" },
	defensive = { label = "Оборона", tip = "Бить тех, кого достаёт; на огонь отвечать погоней не дальше {leash} тайлов и возвращаться на место" },
	hold = { label = "Держать позицию", tip = "С места не сходить: бить только тех, кого достаёт, и под огнём тоже" },
	passive = { label = "Не стрелять", tip = "Огонь не открывать и не отвечать: стрелять только по приказу атаки" },
}

-- Пульс подсказки «Первых шагов» (pulse в hud.ts и bar.ts): обводка огнями команды разгорается и гаснет раз в
-- секунду от low до high; восемь ступеней — плавнее не разглядеть.
local function pulse(ui, low: number, high: number): string
	local phase = ui.now % 1
	local level = math.round((low + (high - low) * (0.5 - 0.5 * math.cos(phase * math.pi * 2))) * 8) / 8
	return string.format("rgba(90 169 255 / %g)", level)
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

-- Доля процентом (percent в bar.ts).
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

-- Энергия сети для подписи (gridState): выработка повреждённых станций дробная — до десятых и вниз, а спрос — вверх,
-- чтобы нехватка не выглядела как «20 из 20».
local function gridState(e: economy.Economy)
	return {
		produced = math.floor(e.produced * 10) / 10,
		demand = math.ceil(e.demand * 10 - 1e-9) / 10,
		peak = math.ceil(e.peak * 10 - 1e-9) / 10,
		stored = math.round(e.stored * 100) / 100,
		overload = economy.overloadOf(e) > 0,
	}
end

-- Подпись энергии сети (gridText).
local function gridText(grid): string
	return "⚡ Энергия зоны: потребляется " .. number(grid.demand) .. " из " .. number(grid.produced)
		.. (if grid.stored > 0 then ", из них " .. number(grid.stored) .. " — из накопителей" else "")
		.. (if grid.peak > grid.demand then ", при полной нагрузке — " .. number(grid.peak) else "")
		.. (if grid.overload then " — перегруз, станции разрушаются" else "")
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

-- Значок груза с количеством (res в widgets.ts).
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

-- Запас груза и что с ним (hint в bar.ts): «Название: значок есть/из» строкой, пояснение — абзацем под ней.
local function stockHint(c, label: string, good: string, have: number, capacity: number, note: string, tone: string, width: number)
	local ui = c.ui
	ui:box({ direction = "row", align = "center", gap = 6, width = width }, function()
		ui:text(label .. ":", { color = tone })
		goodWith(c, good, have, 20, capacity)
	end)
	ui:text(note, { color = tone, wrap = width })
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
			ui:text(tostring(math.floor(credits(c))), { font = "title", color = COLORS.gold, shadow = COLORS.ink, lift = 2 })
			local income = math.round(economy.of(c, c.player).income * 100) / 100
			if income > 0 then
				ui:text("+" .. number(income) .. "/с", { color = COLORS.good })
			end
		end)
		ui:tip("credits", "Кредиты")
		local grid = shownGrid(c)
		if grid then
			local color = if grid.demand > grid.produced or grid.overload then COLORS.bad elseif grid.peak > grid.produced * GRID_TIGHT then COLORS.warn else COLORS.power
			ui:box({ id = "grid" }, function()
				ui:text("⚡ " .. number(grid.demand) .. " / " .. number(grid.produced), { color = color })
			end)
			ui:tip("grid", gridText(grid) .. "\nСеть выбранного здания; ничего не выбрано — сеть главного здания")
		end
		-- Запас в хранилищах.
		local items, capacity = logistics.stockOf(c, c.player)
		if capacity > 0 then
			ui:box({ id = "stock" }, function()
				goodsRow(c, items, "хранилища пусты")
			end)
			ui:tip("stock", "Запас в хранилищах; всего помещается " .. capacity)
		end
		ui:space(0, 0, 1)
		local hour = c.atmosphere.hour or 0
		ui:box({ id = "clock", direction = "row", gap = 4 }, function()
			ui:text(string.format("%02d:%02d", math.floor(hour), math.floor(hour * 60) % 60), { color = COLORS.dim })
		end)
		ui:tip("clock", "Время суток")
		-- Кнопка исследований: открывает дерево технологий, с процентом нынешней темы.
		local current = research.current(c, c.player)
		local state = research.player(c, c.player)
		-- Подсказка «Первых шагов»: следующий шаг — исследовать тему.
		local hint = (currentStep(c) or {}).research
		if ui:button("tech", { active = c.shared.techOpen == true, padding = { 2, 10 }, height = 30, outline = if hint then pulse(ui, 0.3, 1) else nil }, function()
			ui:text("Исследования", shadow())
			if current and state then
				ui:text(math.round(((state.progress or {})[current] or 0) * 100) .. "%", shadow({ color = COLORS.team }))
			end
		end) then
			c.shared.techOpen = not c.shared.techOpen
		end
		ui:tip("tech", "Дерево технологий (R)")
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

-- Описание здания для карточки: что делает и какие здания открывает (aboutOf).
local function aboutOf(c, kind): string
	local info = kind.data.info or kind.data.about or ""
	local opens = {}
	for _, other in construction.menu(c) do
		if other.data.requires and table.find(other.data.requires, kind.name) then
			table.insert(opens, other.data.title or other.name)
		end
	end
	return if #opens > 0 then info .. ". Открывает: " .. table.concat(opens, ", ") else info
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
			local count, hint = 0, false
			for _, kind in options do
				if sectionOf(kind.name) == section.page then
					count += 1
					hint = hint or (step ~= nil and step.building == kind.name)
				end
			end
			-- Раздел появляется, когда в нём открыто хоть одно здание; закрытый оставляет пустую ячейку.
			if count > 0 then
				list[i] = {
					label = section.label,
					picture = c.protos.buildings[section.picture],
					title = section.tip,
					count = count,
					hint = hint,
					run = function()
						page.name = section.page
					end,
				}
			end
		end
		if #surfaces > 0 then
			list[#SECTIONS + 1] = {
				label = "Покрытие",
				picture = c.protos.icons.roads,
				title = "Фундамент, дороги и мосты",
				count = #surfaces,
				run = function()
					page.name = "paving"
				end,
			}
		end
		-- Разбор рамкой — сразу инструмент, без раздела, на месте «Разобрать» здания.
		if paving.enabled(c) then
			local active = stroking == "remove"
			list[DEMOLISH] = {
				label = paving.TITLES.remove,
				picture = c.protos.icons.remove,
				active = active,
				title = "Строители разберут своё в рамке: покрытие, трубы с колодцами и здания, целиком попавшие в неё (за трубы и здания вернут половину цены); недостроенное отменится с возвратом кредитов. Тяни мышью прямоугольник",
				run = function()
					c.shared.mode = if active then nil else { kind = "paving", tool = "remove" }
				end,
			}
		end
		if #tools > 0 then
			list[#SECTIONS + 2] = {
				label = "Логистика",
				picture = c.protos.buildings.pipe,
				title = "Трубы и колодцы: связывают в сеть здания, стоящие поодаль; здания вплотную связаны и так, но только одинаковые",
				count = #tools,
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
			local cost = if tool == "foundation" then paving.FOUNDATION_COST else paving.ROAD_COST
			list[i] = {
				label = paving.TITLES[tool],
				picture = c.protos.icons[paving.ICONS[tool]],
				cost = if active and shown and shown.tiles > 1 then shown.cost else cost,
				title = PAVE_TIPS[tool],
				active = active,
				run = function()
					c.shared.mode = if active then nil else { kind = "paving", tool = tool }
				end,
			}
		end
		list[BACK] = {
			label = "Назад",
			title = "К разделам; Esc отменяет выбор места",
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
			pipe = "Связывает в сеть здания, стоящие поодаль (одинаковые здания вплотную связаны и без трубы): по трубам идут груз и энергия, они расширяют зону. Перекрывает проезд — под проездом веди колодцами. Своя зона не нужна. Тяни мышью линию",
			well = "Колодцы — концы подземной трубы: щелчок ставит один (свяжется с колодцем по прямой), протяжка — пару, до 10 тайлов. Над ней ездят и строят, уязвимы только колодцы. Своя зона не нужна",
		}
		for i, kind in tools do
			local active = stroking == kind.name
			local shown = c.shared.paving
			list[i] = {
				label = TOOL_NAMES[kind.name] or kind.data.title,
				picture = kind,
				cost = if active and shown and shown.tiles > 1 then shown.cost else kind.data.cost,
				short = free < kind.data.cost,
				title = tips[kind.name],
				active = active,
				zones = true,
				run = function()
					c.shared.mode = if active then nil else { kind = "paving", tool = kind.name }
				end,
			}
		end
		list[BACK] = {
			label = "Назад",
			title = "К разделам; Esc отменяет выбор места",
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
			label = kind.data.title or kind.name,
			picture = kind,
			cost = kind.data.cost,
			materials = kind.data.materials,
			c = c,
			stock = (logistics.stockOf(c, c.player)),
			power = if power ~= 0 then power else nil,
			idle = if idle ~= power then idle else nil,
			short = not affordable,
			about = aboutOf(c, kind),
			title = if affordable then nil else "Сейчас кредитов на всю цену нет — заложить можно: платят по ходу стройки, и она подождёт, пока их прибавится",
			active = placing == kind.name,
			zones = true,
			hint = step ~= nil and step.building == kind.name,
			run = function()
				c.shared.mode = if placing == kind.name then nil else { kind = "placing", building = kind.name }
			end,
		}
		-- Стену и ворота не ставят по одной, а тянут мышью линией, как трубу: их кнопка включает протяжку (wallSlot).
		if kind.name == "wall" or kind.name == "gate" then
			local slot = list[index]
			local active = stroking == kind.name
			local shown = c.shared.paving
			slot.active = active
			slot.cost = if active and shown and shown.tiles > 1 then shown.cost else kind.data.cost
			slot.title = if affordable then "Тяни мышью линию; щелчок ставит одну" else "Тяни мышью линию; щелчок ставит одну. Сейчас кредитов на всю цену нет — заложить можно: платят по ходу стройки, и она подождёт, пока их прибавится"
			slot.run = function()
				c.shared.mode = if active then nil else { kind = "paving", tool = kind.name }
			end
		end
	end
	list[BACK] = {
		label = "Назад",
		title = "К разделам; Esc отменяет выбор места",
		run = function()
			if placing or stroking then
				c.shared.mode = nil
			end
			page.name = "root"
		end,
	}
end

-- Ячейки сетки команд для выбранного: у строителей — стройка, у своего завода — заказ юнитов, у MCV и главного
-- здания — превращение, у своей стройки — отмена, у готового здания — разбор.
-- Торговля у космопорта (commands.ts): страница — корень, продажа или закупка; deal — набираемая сделка: что и
-- сколько. Сбрасывается, когда выбран другой космопорт.
local DEAL_STEPS = { 10, 50, 100 }
local DEAL_START = 50
local market = { port = -1, page = "root", deal = nil :: { resource: string, amount: number }? }

-- Что можно продать из запаса игрока: сколько всего, сколько в сети космопорта и почём (offers в hud.ts).
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

-- Что можно купить с орбиты: почём, сколько влезет в склад космопорта и что надо изучить (purchases в hud.ts).
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

-- Сделка в пределах возможного (dealOf): продажа — не больше запаса, закупка — на сколько хватает кредитов и трюма.
-- nil — такого ресурса космопорт сейчас не предлагает.
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
	local max = if buying then math.max(0, math.min(room, math.floor(credits(c) / item.price))) else item.available
	return { resource = item.resource, amount = math.max(0, math.min(max, math.floor(deal.amount))), price = item.price, max = max, room = room }
end

-- Сетка космопорта (trade в commands.ts): продажа и закупка — каждая на своей странице, набор количества, заявка.
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
			label = "Продажа",
			picture = c.protos.buildings.spaceport,
			active = order ~= nil,
			title = if order then "Идёт продажа: открыть заявку" else "Продать ресурсы с орбиты",
			hint = order == nil and (currentStep(c) or {}).sell == true,
			run = function()
				open("sell")
			end,
		}
		list[CANCEL] = {
			label = "Закупка",
			picture = c.protos.buildings.spaceport,
			disabled = order ~= nil,
			title = if order then "Космопорт занят продажей" else "Заказать ресурсы с орбиты втрое дороже цены продажи",
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
				local title = c.protos.goods[item.resource].data.title
				local topic = item.research and research.topic(c, item.research)
				list[i] = {
					label = if buying then title else title .. " ×" .. limit.max,
					picture = c.protos.goods[item.resource],
					disabled = limit.max < 1 or item.research ~= nil,
					title = if topic then "Нужно исследование: " .. topic.data.title
						elseif limit.max >= 1 then (if buying then "По " .. item.price .. " за единицу, корабль прилетит через 20 с"
							elseif item.here and item.here < limit.max then "По " .. item.price .. " за единицу. В сети космопорта " .. item.here .. ", остальное привезут грузовики из других сетей"
							else "По " .. item.price .. " за единицу")
						elseif limit.room < 1 and buying then "Не помещается в склад космопорта"
						else "Не хватает кредитов",
					run = function()
						market.deal = { resource = item.resource, amount = limit.amount }
					end,
				}
			end
			list[BACK] = {
				label = "Назад",
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
			list[#DEAL_STEPS + 1] = { label = "Всё", active = amount >= max, title = "×" .. max, run = function()
				set(max)
			end }
			list[CONVERT] = {
				label = (if buying then "Закупка" else "Продажа") .. " ×" .. amount,
				picture = c.protos.goods[resource],
				cost = amount * price,
				gain = not buying,
				disabled = amount < 1,
				title = if buying then "По " .. price .. " за единицу, корабль прилетит через 20 с" else "По " .. price .. " за единицу",
				run = function()
					c:send(if buying then "buy" else "sell", { port = port, resource = resource, amount = amount })
					market.deal = nil
				end,
			}
			list[BACK] = {
				label = "Назад",
				run = function()
					market.deal = nil
				end,
			}
		end
	else
		if order.total <= 0 and not order.buy then
			local delivered = math.floor(trade.delivered(c, port))
			list[CANCEL] = {
				label = if delivered > 0 then "Отправить" else "Снять заявку",
				title = if delivered > 0 then "Корабль улетит с тем, что уже привезли" else nil,
				run = function()
					c:send("closeSale", { port = port })
				end,
			}
		end
		list[BACK] = {
			label = "Назад",
			run = function()
				open("root")
			end,
		}
	end
end

-- Уничтожить выбранных своих юнитов (scuttle в commands.ts): сначала кнопка, потом подтверждение на своей странице —
-- и на другой клавише. key — выделение, для которого открыто подтверждение; сменилось — страница закрыта.
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
		label = "Уничтожить: " .. #gift,
		title = "Подтвердить: юниты взорвутся сразу, отменить нельзя",
		run = function()
			c:send("scuttle", { units = gift })
			scuttling.key = ""
		end,
	}
	list[BACK] = {
		label = "Назад",
		run = function()
			scuttling.key = ""
		end,
	}
	return list
end

-- Уровень выбранных своих готовых зданий, которые улучшают (level в hud.ts): level, gain и factor — первого из них;
-- next — заказ следующего уровня всем, кого можно поднять сейчас: цена вместе и чего не хватает; raising — те, что уже
-- поднимают, и как идёт работа у первого из них. nil — таких зданий не выбрано.
local function levelState(c, selection)
	local state = nil
	local materials = {}
	for _, e in selection do
		local kind = kinds.of(c, e)
		local gain = kind and logistics.isReady(c, c.player, e) and levels.gain(kind)
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
		if credits(c) < state.next.cost and state.next.lack ~= "research" then
			state.next.lack = "credits"
		end
	end
	return state
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
				label = if state.unit then "Развернуть" else "Свернуть в MCV",
				picture = building,
				about = if state.unit then building.data.info else nil,
				title = if state.unit then "Выбрать место: MCV доедет и развернётся там. Нужна свободная скала или фундамент 3×3" else nil,
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
				label = "Отменить",
				run = function()
					c:send("cancelDeploy", { unit = e })
				end,
			}
		end
	end
	-- Свои бойцы без строителей: стойки — общая горит, если она у всех одна, — и патруль (tactics в hud.ts).
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
					label = STANCES[name].label,
					title = (string.gsub(STANCES[name].tip, "{leash}", tostring(tactics.leash))),
					active = stance == name,
					run = function()
						c:send("stance", { units = units, stance = name })
					end,
				}
			end
			local picking = c.shared.mode ~= nil and c.shared.mode.kind == "patrolling"
			list[5] = {
				label = "Патруль",
				title = "P, потом щелчок по карте — бойцы ходят между своим местом и точкой; Shift+щелчок — ещё точка к патрулю",
				active = picking or patrolling > 0,
				run = function()
					c.shared.mode = if picking then nil else { kind = "patrolling", selects = true }
				end,
			}
		end
	end
	if #selection == 1 and c:has(selection[1], "Producer") and c:mine(selection[1]) and not c:has(selection[1], "Site") then
		local building = selection[1]
		local kind = c:proto(building)
		local money = credits(c)
		local producer = c:get(building, "Producer")
		local orders = #producer.queue + (if producer.unit ~= "" then 1 else 0)
		-- Очередь полна — заказывать некуда (QUEUE_LIMIT).
		local full = orders >= c.protos.mechanics.production.data.queue
		local techTree = construction.rules(c).techTree
		for _, name in kind.data.produces or {} do
			local unit = c.protos.units[name]
			if unit then
				local missing = if techTree then construction.missing(c, c.player, unit.data.requires) else {}
				local topic = if construction.researched(c, c.player, unit.data.research) then nil else research.topic(c, unit.data.research)
				local titles = {}
				for _, needed in missing do
					local other = c.protos.buildings[needed]
					table.insert(titles, if other then other.data.title else needed)
				end
				local affordable = money >= unit.data.cost
				table.insert(list, {
					label = unit.data.title or name,
					picture = unit,
					cost = unit.data.cost,
					materials = unit.data.materials,
					c = c,
					stock = (logistics.stockOf(c, c.player)),
					short = not affordable,
					about = unit.data.about,
					unit = unit,
					disabled = not affordable or full or #missing > 0 or topic ~= nil,
					title = if #missing > 0 then "Нужно построить: " .. table.concat(titles, ", ")
						elseif topic then "Нужно исследование: " .. topic.data.title
						elseif full then "Очередь заполнена"
						elseif not affordable then "Не хватает кредитов"
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
				label = "Отменить заказ",
				title = "Последний в очереди; кредиты вернутся",
				run = function()
					c:send("cancel", { building = building })
				end,
			}
		end
	end
	-- Своя готовая ракетная шахта: боеголовка, пуск и отмена (silo в commands.ts).
	local silo = #selection == 1 and selection[1]
	local state = silo and c:mine(silo) and logistics.isReady(c, c.player, silo) and c:get(silo, "Silo")
	local warhead = state and c:proto(silo).data.warhead
	if state and warhead and page.name == "root" then
		local stage = if state.start >= 0 then "launching" elseif state.ready then "ready" elseif state.ticks > 0 then "assembling" else "empty"
		local lack = silos.warheadLack(c, c.player, silo)
		local aiming = c.shared.mode ~= nil and c.shared.mode.kind == "aiming" and c.shared.mode.silo == silo
		list[1] = {
			label = "Боеголовка",
			picture = c.protos.goods.rods,
			cost = if stage == "empty" then warhead.cost else nil,
			materials = if stage == "empty" then warhead.materials else nil,
			c = c,
			stock = (logistics.stockOf(c, c.player)),
			about = "Ядерная боеголовка для пуска. Шахта держит одну",
			active = stage ~= "empty",
			disabled = lack ~= nil,
			title = if stage ~= "empty" then "В шахте уже есть боеголовка — готовая или в сборке"
				elseif lack == "credits" then "Не хватает кредитов"
				elseif lack == "materials" then "В сети шахты не хватает стержней или компонентов"
				else "Сборка идёт " .. clockOf(warhead.seconds) .. " при полной энергии. Цена списывается сразу, стержни и компоненты — из сети шахты",
			run = function()
				c:send("warhead", { silo = silo })
			end,
		}
		list[2] = {
			label = "Пуск",
			about = "Навести боеголовку на точку карты и пустить ракету",
			active = aiming,
			disabled = stage ~= "ready" and stage ~= "launching",
			title = if stage == "launching" then "Пуск идёт: щёлкни по карте, чтобы навести ракету заново"
				elseif stage == "ready" then "Щёлкни по карте — туда придёт удар. Ракета стартует через " .. warhead.launch .. " с, о пуске узнают все"
				else "Сначала собери боеголовку",
			run = function()
				c.shared.mode = if aiming then nil else { kind = "aiming", silo = silo }
			end,
		}
		if stage == "assembling" then
			list[CANCEL] = { label = "Отменить", title = "Бросить сборку: её цена вернётся целиком", run = function()
				c:send("cancelWarhead", { silo = silo })
			end }
		elseif stage == "launching" then
			list[CANCEL] = { label = "Отменить пуск", title = "Ракета не стартует, боеголовка останется в шахте", run = function()
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
	local root = page.name == "root" and (not trading or market.page == "root")
	-- Свои готовые здания, которые улучшают: следующий уровень или отмена начатого (level в commands.ts).
	local raise = root and #buildersOf(c, selection) == 0 and levelState(c, selection)
	local upcoming = raise and raise.next
	if upcoming then
		local topic = research.topic(c, upcoming.topic)
		list[UPGRADE] = {
			label = "Уровень " .. upcoming.level,
			picture = c:proto(upcoming.buildings[1]),
			cost = upcoming.cost,
			materials = upcoming.materials,
			c = c,
			stock = (logistics.stockOf(c, c.player)),
			short = upcoming.lack == "credits",
			disabled = upcoming.lack ~= nil,
			title = if upcoming.lack == "research" then "Нужно исследование: " .. (if topic then topic.data.title else upcoming.topic)
				elseif upcoming.lack == "credits" then "Не хватает кредитов"
				elseif upcoming.lack then "В зоне здания не хватает готового на улучшение"
				else "Поднять уровень: " .. levels.GAINS[raise.gain] .. " ×" .. number(upcoming.factor) .. ". Цена списывается сразу, готовое берётся из сети здания; работу делают строители, здание при этом работает",
			run = function()
				for _, e in upcoming.buildings do
					c:send("upgrade", { building = e, builders = {} })
				end
			end,
		}
	elseif raise and raise.raising then
		local raising = raise.raising.buildings
		list[UPGRADE] = {
			label = "Отменить",
			title = "Отменить улучшение: его цена вернётся целиком",
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
			label = if site.demolish then "Отменить разбор" else "Отменить стройку",
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
			label = if plant.on then "Выключить" else "Включить",
			picture = c.protos.goods[plant.recipe],
			lamp = plant.on,
			title = if plant.on then "Завод встанет и перестанет брать энергию; начатая сборка подождёт включения, сырьё увезут в хранилища" else "Завод начнёт заказывать сырьё у зоны и собирать до нормы",
			run = function()
				c:send("work", { building = e, on = not plant.on })
			end,
		}
	end
	if #switchable > 0 and root and not list[SWITCH] then
		list[SWITCH] = {
			label = if on then "Выключить" else "Включить",
			lamp = on,
			title = if on then "Перестанет брать энергию у зоны и работать" else "Снова возьмёт энергию у зоны и заработает",
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
			label = "Уничтожить",
			title = "Выбранные юниты взорвутся на месте: кредиты не вернутся, место в лимите освободится",
			run = function()
				scuttling.key = table.concat(selection, ",")
			end,
		}
	end
	if #demolish > 0 and root then
		list[DEMOLISH] = {
			label = "Разобрать",
			cost = refund,
			gain = true,
			title = "Здание разберут строители; когда закончат, вернётся половина цены",
			run = function()
				for _, e in demolish do
					c:send("demolish", { building = e, builders = {} })
				end
			end,
		}
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
						ui:text("без дела " .. number(slot.idle), { color = COLORS.dim })
					end
				end
			end)
		end
		-- Материалы: значок, название и сколько нужно; не хватает в хранилищах — сколько есть из нужного.
		if slot.materials then
			for _, name in goods.names(slot.c) do
				local amount = slot.materials[name]
				local kind = slot.c.protos.goods[name]
				if amount and kind then
					local stored = math.floor(slot.stock[name] or 0)
					local short = stored < amount
					ui:box({ direction = "row", align = "center", gap = 6 }, function()
						ui:image(kind, 16, 16)
						ui:box({ grow = 1 }, function()
							ui:text(kind.data.title, { ellipsis = true })
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
					local outline = if slot.hint and not slot.disabled then pulse(ui, 0.3, 1) else nil
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
						card(ui, slot, hotkey)
					end, if grid then { right = math.max(8, c.screen.w - c.input.x - 40), bottom = c.screen.h - grid.y + 12 } else nil)
					-- Пока смотрят кнопку здания, на карте видны границы зон (controls/build).
					if slot.zones and ui:hovered(id) then
						c.shared.zonesHover = true
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
	local title = if kind and kind.data then kind.data.title or kind.name else "?"
	local site = not many and c:get(first, "Site")
	if site then
		title = (if site.undo then "Отмена стройки: " elseif site.demolish then "Разбор: " else "Стройка: ") .. title
	end
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
			-- Боеприпасы своих выбранных юнитов с магазинами: сколько в среднем осталось (army.ammo в hud.ts).
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
					ui:text("Боеприпасы: " .. percent(filled / magazines) .. ". Магазины пополняются в своей сети из хранилищ и у машины снабжения, авиация — над аэродромом", { color = COLORS.soft, wrap = text })
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
				stockHint(c, "Боеприпасы", "ammo", bays, bayCapacity, if bays <= 0 then "Пусто: ждёт грузовики, хранилища сети или станцию поставки" else "Раздаёт своим в радиусе " .. serves.radius .. " тайлов; потратит четверть — грузовики привезут в поле, в сети грузится из хранилищ, у станции поставки — вчетверо быстрее", tone, text)
			end
			if site then
				local progress = math.min(1, site.progress / site.total)
				local label
				if site.demolish then
					label = if progress < 1 then "Разбирается — осталось " .. percent(progress) else "Ждёт строителя: выбери его и щёлкни по зданию правой кнопкой"
				elseif c:has(first, "Footprint") then
					label = if c:mine(first) and construction.short(c, c.player)[first] then "Ждёт кредитов — готово " .. percent(progress) .. ": стройку оплачивают по ходу" else "Строится — " .. percent(progress)
				else
					label = if site.blocked then "Место занято юнитами" else "Ждёт строителя"
				end
				widgets.bar(ui, progress, label, text)
			end
			-- Энергия: у электростанции и накопителя — их сети; генератор материи вне сети с главным зданием; подмога;
			-- нехватка; выключено (bar.ts).
			local built = not many and not site and kind and c:has(first, "Building")
			if built and ((kind.data.power or 0) > 0 or kind.data.battery) then
				local _, zone = economy.gridOf(c, first)
				if zone then
					local grid = gridState(zone)
					ui:text(gridText(grid), { color = if grid.demand > grid.produced or grid.overload then COLORS.bad else COLORS.power, wrap = text })
				end
			end
			if built and economy.coreless(c)[first] then
				ui:text("Денег не приносит: в зоне нет главного здания", { color = COLORS.warn, wrap = text })
			end
			if built and c:mine(first) and kind.name == economy.CORE and credits(c) < economy.RELIEF_BELOW then
				ui:text("Подмога: пока кредитов меньше " .. economy.RELIEF_BELOW .. ", главное здание даёт " .. economy.RELIEF_INCOME .. " в секунду", { color = COLORS.soft, wrap = text })
			end
			local starved, off = false, false
			for _, e in selection do
				if c:has(e, "Building") and not c:has(e, "Site") then
					starved = starved or economy.states(c)[e] == "starved"
					off = off or (economy.shutDown(c, c.player, e) and not c:has(e, "Assembly"))
				end
			end
			if starved then
				ui:text("⚡ Не хватает энергии: здание работает медленнее или стоит", { color = COLORS.bad, wrap = text })
			end
			local switchedOn = false
			for _, e in selection do
				if c:mine(e) and c:has(e, "Building") and not c:has(e, "Site") and not c:has(e, "Off") and not c:has(e, "Assembly") and economy.switchable(kinds.of(c, e)) then
					switchedOn = true
				end
			end
			if off and not switchedOn then
				ui:text("Выключено: энергию не берёт и не работает; включи в сетке справа", { color = COLORS.warn, wrap = text })
			end
			-- Своё повреждённое: сколько стоит починка (у стройки прочность — та же доля, что полоса стройки).
			local health = not many and not site and c:mine(first) and c:get(first, "Health")
			if health and health.value < health.max and construction.isRepairable(c, first) then
				local repair = construction.repairCostOf(kind.data.cost, health.value, construction.rules(c).repairCost, health.max)
				ui:text("Прочность: " .. percent(health.value / health.max) .. ". Починка стоит " .. repair .. ": выбери строителей и щёлкни по зданию правой кнопкой", { color = COLORS.soft, wrap = text })
			end
			-- Генератор щита: запас купола или когда он поднимется.
			local dome = not many and built and kind.data.shield
			local shield = dome and c:get(first, "Shield")
			if shield then
				local down = math.max(0, math.ceil((shield.down - c.tick) * c.step))
				ui:text(if down > 0 then "Щит пробит: поднимется через " .. down .. " с" else "Щит: " .. math.floor(shield.charge) .. " из " .. dome.capacity, { color = COLORS.soft, wrap = text })
			end
			-- Склад здания, кузов грузовика и его работа, остаток месторождения под шахтой.
			local stock = not many and c:mine(first) and c:get(first, "Inventory")
			local hauler = not many and c:get(first, "Hauler")
			if stock and hauler then
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					ui:text("Груз:")
					goodsRow(c, stock.items, "пусто")
					ui:text("из " .. stock.capacity)
				end)
				local job
				if hauler.mine >= 0 then
					job = "Работа: возит руду из шахты на переработку"
				elseif hauler.pickup >= 0 then
					job = "Работа: вывозит груз с земли"
				elseif hauler.to >= 0 and c:alive(hauler.to) then
					local kind = c.protos.goods[hauler.resource]
					local name = widgets.lower(if kind then kind.data.title else hauler.resource)
					local left = math.floor(math.max(0, if hauler.full then goods.amount(stock, hauler.resource) else hauler.amount))
					local toKind = c:proto(hauler.to)
					local fromKind = hauler.from >= 0 and c:alive(hauler.from) and c:proto(hauler.from)
					job = if fromKind and not hauler.full
						then "Работа: перевозит " .. name .. " из «" .. fromKind.data.title .. "» в «" .. toKind.data.title .. "», осталось " .. left
						else "Работа: везёт " .. name .. " в «" .. toKind.data.title .. "», осталось " .. left
				else
					job = "Работа: сам — возит то, что заказывают здания. Правый щелчок по зданию — приказ"
				end
				ui:text(job, { color = COLORS.soft, wrap = text })
			elseif stock and built and kind.data.ammo then
				-- У турели на складе только боеприпасы.
				local have = math.floor(goods.amount(stock, "ammo"))
				local tone = if have <= 0 then COLORS.warn else COLORS.soft
				stockHint(c, "Боеприпасы", "ammo", have, stock.capacity, if have <= 0 then "Пусто: турель молчит, пока не подвезут" else "Расстреляет четверть — грузовики подвезут из хранилищ зоны", tone, text)
			elseif stock and built then
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					ui:text((if kind.data.stores then "Хранилище" else "Склад") .. ":")
					goodsRow(c, stock.items, "пусто")
					ui:text("— вмещает " .. stock.capacity .. (if (stock.reserve or 0) > 0 then ", резерв " .. stock.reserve else ""), { color = COLORS.dim })
				end)
			end
			-- Реактор: сколько стержней и горит ли стержень.
			local burns = built and kind.data.burns
			if stock and built and burns then
				local have = math.floor(goods.amount(stock, burns.good))
				local burning = economy.burning(c, first)
				local tone = if have <= 0 and not burning then COLORS.warn else COLORS.soft
				stockHint(c, "Стержни", burns.good, have, stock.capacity, if burning then "Стержень горит минуту; грузовики подвозят новые из хранилищ зоны" else "Стержня в работе нет: реактор не вырабатывает", tone, text)
			end
			-- Уровень здания и как идёт улучшение.
			local raise = built and levelState(c, selection)
			if raise then
				ui:text(if raise.level > 1 then "Уровень " .. raise.level .. " из " .. levels.MAX_LEVEL .. ": " .. levels.GAINS[raise.gain] .. " ×" .. number(raise.factor) else "Уровень " .. raise.level .. " из " .. levels.MAX_LEVEL, { color = COLORS.soft, wrap = text })
				if raise.raising then
					local progress = raise.raising.progress
					widgets.bar(ui, progress, if progress > 0 then "Улучшается — готово " .. percent(progress) else "Улучшение ждёт строителя: выбери его и щёлкни по зданию правой кнопкой", text)
				end
			end
			-- Ракетная шахта: сборка боеголовки, готова, пуск.
			local silo = built and c:mine(first) and kind.data.warhead and c:get(first, "Silo")
			if silo then
				if silo.start >= 0 then
					local left = math.max(0, silo.start + math.floor(kind.data.warhead.launch / c.step + 0.5) - c.tick)
					ui:text("Пуск: старт через " .. math.ceil(left * c.step) .. " с", { color = COLORS.warn, wrap = text })
				elseif silo.ticks > 0 and not silo.ready then
					local progress = math.min(1, silo.progress / silo.ticks)
					widgets.bar(ui, progress, "Боеголовка — собрано " .. percent(progress), text)
				else
					ui:text(if silo.ready then "Боеголовка готова: «Пуск» — навести на цель" else "Боеголовки нет: собери её, чтобы пустить ракету", { color = COLORS.soft, wrap = text })
				end
			end
			-- Перехватчик: сколько ракет, собирает ли следующую и что мешает.
			local guard = built and c:mine(first) and kind.data.intercept
			local charge = guard and c:get(first, "Interceptor")
			if charge then
				local count, capacity = charge.missiles, guard.capacity
				if charge.ticks > 0 then
					local progress = math.min(1, charge.progress / charge.ticks)
					widgets.bar(ui, progress, "Ракет " .. count .. " из " .. capacity .. "; следующая — собрано " .. percent(progress), text)
				else
					local lack = silos.interceptorLack(c, first)
					local list = {}
					for _, name in goods.names(c) do
						local amount = guard.materials[name]
						if amount then
							table.insert(list, amount .. " " .. widgets.lower(c.protos.goods[name].data.title))
						end
					end
					ui:text(if lack == "off" then "Выключен: ракет " .. count .. " из " .. capacity .. ", новые не собирает и не стреляет"
						elseif lack == "credits" then "Ракет " .. count .. " из " .. capacity .. ": на сборку следующей нужно " .. guard.cost .. " кредитов"
						elseif lack == "materials" then "Ракет " .. count .. " из " .. capacity .. ": в сети не хватает — нужно " .. table.concat(list, ", ")
						else "Ракет " .. count .. " из " .. capacity .. ": собьют ядерные, что метят ближе " .. guard.radius .. " тайлов", { color = COLORS.soft, wrap = text })
				end
			end
			-- Космопорт: рейс, набираемая сделка или что тут можно (trade в bar.ts).
			if built and c:mine(first) and trade.isPort(c, c.player, first) then
				local order = c:get(first, "Trade")
				if order then
					local name = widgets.lower(c.protos.goods[order.resource].data.title)
					local wanted = math.floor(order.wanted + 0.5)
					local label, progress
					if order.buy then
						progress = 1 - order.left / order.total
						label = "Закупка летит: " .. name .. " ×" .. wanted .. ", оплачено " .. wanted * trade.buyPrice(c, order.resource)
					elseif order.total > 0 then
						progress = 1 - order.left / order.total
						label = "Корабль в пути: " .. name .. " ×" .. wanted .. " за " .. wanted * trade.price(c, order.resource)
					else
						local delivered = math.floor(trade.delivered(c, first))
						progress = delivered / order.wanted
						label = "Грузовики везут " .. name .. ": " .. delivered .. " из " .. wanted
					end
					widgets.bar(ui, progress, label, text)
				else
					local buying = market.page == "buy"
					local deal = market.port == first and (market.page == "sell" or buying) and market.deal and dealOf(c, first, buying, market.deal)
					if deal then
						ui:box({ direction = "row", align = "center", gap = 6 }, function()
							ui:text((if buying then "Закупка" else "Продажа") .. ":", { color = COLORS.soft })
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
						ui:text(if buying
							then "Цена " .. deal.amount * deal.price .. ", в трюме останется место на " .. deal.room - deal.amount
							else "Выручка " .. deal.amount * deal.price .. ", в запасе останется " .. deal.max - deal.amount, { color = COLORS.soft, wrap = text })
					else
						ui:text((if #offersOf(c, first) > 0
							then "Продажа из всех ваших хранилищ: выберите ресурс, потом количество. Что лежит не в сети космопорта, привезут грузовики"
							else "Продавать нечего: хранилища пусты") .. ". Закупка с орбиты — втрое дороже продажи, привезённое грузовики развезут по хранилищам", { color = COLORS.soft, wrap = text })
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
						ui:text(ore.data.title .. ": " .. (if left > 0 then "осталось " .. math.floor(left) else "месторождение выработано"), { color = COLORS.soft })
					end)
				end
			end
			-- Лаборатория: что ведут и почему стоит.
			local lab = built and c:mine(first) and c:get(first, "Research")
			if lab then
				local topic = research.current(c, c.player)
				local state = research.player(c, c.player)
				if not topic then
					ui:text("Лаборатория ждёт: выбери тему в дереве технологий (R)", { color = COLORS.soft, wrap = text })
				else
					local progress = (state and state.progress or {})[topic] or 0
					widgets.bar(ui, progress, research.topic(c, topic).data.title .. " — исследовано " .. percent(progress), text)
					if lab.lack ~= "off" then
						local goodKind = c.protos.goods[lab.lack]
						local message = if lab.lack == "power" then "Не хватает энергии: лаборатория работает медленнее"
							elseif lab.lack == "credits" then "Не хватает кредитов: лаборатория стоит"
							elseif goodKind then "В сети лаборатории нет: " .. goodKind.data.title
							else "Скорость выбранных лабораторий: ×" .. lab.speed
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
					ui:text("Материалы:", { color = if waiting then COLORS.warn else COLORS.soft })
					for _, name in goods.names(c) do
						if materials[name] then
							goodWith(c, name, if have then goods.amount(have, name) else 0, 20, materials[name])
						end
					end
				end)
				if waiting then
					ui:text("Ждёт подвоза: по трубам, грузовиком или своим строителем со склада", { color = COLORS.warn, wrap = text })
				end
			end
			-- Цех: рецепт, сколько изделия у зоны и что он делает.
			local assembly = built and c:mine(first) and c:get(first, "Assembly")
			local product = assembly and c.protos.goods[assembly.recipe]
			if assembly and product then
				local seconds = 0
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					for _, name in goods.names(c) do
						local amount = product.data.recipe[name]
						if amount then
							goodWith(c, name, amount, 20)
							seconds += amount
						end
					end
					ui:text("→")
					goodWith(c, product.name, product.data.yield, 20)
					ui:text("за " .. seconds .. " с", { color = COLORS.dim })
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
				local phase = if not assembly.on then (if assembly.progress > 0 then "выключен, доделывает сборку" else "выключен") elseif assembly.progress > 0 then "собирает" elseif full then "хранилища полны, ждёт" else "ждёт сырья"
				widgets.bar(ui, assembly.progress / math.max(seconds, 1e-9), product.data.title .. " в зоне: " .. math.floor(zoneStock) .. " — " .. phase, text)
				if not assembly.on then
					ui:text("Завод выключен: включи его в сетке справа", { color = COLORS.warn, wrap = text })
				end
			end
			local cell = built and c:get(first, "Accumulator")
			if cell and kind.data.battery then
				local flow = math.round(cell.flow * 100) / 100
				local charge, capacity = math.floor(cell.charge), kind.data.battery.capacity
				ui:text("Заряд: " .. charge .. " из " .. capacity .. (if flow > 0 then ", отдаёт " .. number(flow) .. " ⚡" elseif flow < 0 then ", копит " .. number(-flow) .. " ⚡" else ""), { color = COLORS.soft, wrap = text })
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
			local mode = c.shared.mode
			if #buildersOf(c, selection) > 0 and not (mode and mode.kind == "placing") then
				ui:text("Строит здания и чинит своё: правый щелчок по стройке или повреждённому. Здания — в сетке справа", { color = COLORS.soft, wrap = text })
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
			-- полёте — белые точки (minimap.ts).
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
				nothing(ui, infoWidth, INNER)
			end
			commandGrid(c, if selected then slots(c, selection) else {}, GRID_WIDTH, INNER)
		end)
	end)
end

-- Ширина экрана, ниже которой список шагов сжимается до текущего (NARROW).
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

-- Первые шаги новичка в углу (steps в hud.ts): список с галочками, у текущего — что сделать и зачем. Заголовок
-- сворачивает список, крестик прячет совсем (вернуть — в настройках). Мир, где всё уже пройдено при входе, списка не
-- показывает.
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
				ui:text("Первые шаги", shadow())
				ui:text(count .. "/" .. #stepsLib.LIST, shadow({ font = "small", color = COLORS.gold }))
				ui:text(if shown == "open" then "▾" else "▸", shadow({ font = "small" }))
			end) then
				settings.setPref(c, "steps", if shown == "open" then "folded" else "open")
			end
			ui:tip("steps:toggle", if shown == "open" then "Свернуть список" else "Развернуть список")
			if ui:button("steps:close", { height = 28, padding = { 0, 8 } }, function()
				ui:text("×", shadow())
			end) then
				settings.setPref(c, "steps", "off")
			end
			ui:tip("steps:close", "Скрыть: вернуть можно в меню, «Настройки»")
		end)
		if shown ~= "open" then
			return
		end
		if not current then
			ui:box({ padding = { 0, 2 } }, function()
				ui:text("Первые шаги пройдены! Дальше — больше добычи и переработки, новые исследования и оборона базы.", { color = COLORS.good, wrap = width - 24 })
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
						ui:text(step.title, { color = color, wrap = width - 46 })
						if i ~= current then
							return
						end
						ui:text(step.tip, { font = "small", color = COLORS.soft, wrap = width - 46 })
						if target then
							ui:space(0, 2)
							if ui:button("steps:show", { height = 28, padding = { 0, 10 } }, function()
								ui:text("Показать", shadow())
							end) then
								c.shared.flyTo = { x = target.x + target.width / 2, y = target.y + target.height / 2 }
							end
							ui:tip("steps:show", "Камера — к месту, где сделать этот шаг; на карте оно обведено")
						end
					end)
				end)
			end
		end)
	end)
end

-- Режимы наведения: название и что делать (mode в hud.ts).
local MODES = {
	deploying = { name = "Разворачивание MCV", tip = "Щёлкни, где развернуть: на зелёном можно, MCV доедет сам" },
	patrolling = { name = "Патруль", tip = "Щёлкни, докуда патрулировать; с Shift — ещё точка" },
	aiming = { name = "Ядерный удар", tip = "Щёлкни по карте — туда придётся удар" },
	placing = { name = "Стройка: {name}", tip = "Щёлкни, где заложить, — можно ещё и ещё" },
	paving = { name = "{name}", tip = "Зажми кнопку и тяни по карте" },
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
	-- Справа — «Первые шаги», слева — уведомления: середина не наезжает на них.
	local room = if stepsShown(c) and ui.width >= NARROW then math.min(ui.width - 24, math.max(280, ui.width - 2 * 324)) else ui.width - 24
	ui:box({ anchor = { centerX = 0, top = TOP_HEIGHT + 6 } }, function()
		ui:box({ id = "mode", skin = "panel", padding = { 10, 12, 10, 16 }, direction = "row", align = "center", gap = 12, maxWidth = room }, function()
			local building = mode.building and c.protos.buildings[mode.building]
			local name = building and building.data.title or ""
			local tip = spec.tip
			if mode.kind == "paving" then
				local tool = c.protos.buildings[mode.tool]
				name = TOOL_NAMES[mode.tool] or (tool and tool.data.title) or mode.tool
				local shown = c.shared.paving
				if shown and shown.tiles > 0 then
					tip = "Тяни по карте: " .. shown.tiles .. " тайл., " .. shown.cost .. " кредитов"
					if (shown.short or 0) > 0 then
						tip ..= "; на " .. shown.short .. " тайл. не хватает кредитов — они жёлтые"
					end
				elseif mode.tool == "remove" then
					tip = "Тяни рамку по тому, что разобрать"
				end
			end
			ui:text((string.gsub(spec.name, "{name}", name)), { color = COLORS.team })
			ui:text(tip, { color = COLORS.soft, wrap = math.max(160, room - 320) })
			if ui:button("mode:cancel", { height = 32, padding = { 2, 14 } }, function()
				ui:text("Отмена", shadow())
			end) then
				c.shared.mode = nil
			end
			ui:tip("mode:cancel", "То же — правая кнопка мыши или Esc")
		end)
	end)
end

-- Сколько секунд сообщение о награде висит на экране (TOAST_SECONDS).
local TOAST_SECONDS = 5

-- Награды под полосой режима (toastColumn в hud.ts): монета, сумма и за что; mechanics/economy кладёт их в
-- c.shared.rewards.
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
				table.insert(opens, other.data.title)
			end
			for _, other in units do
				table.insert(opens, other.data.title)
			end
			for _, kind in paving.opens(toast.topic) do
				table.insert(opens, paving.TITLES[kind])
			end
			local id = "learned:" .. i
			if ui:button(id, { skin = "panel", direction = "column", align = "center", gap = 2, padding = { 10, 16 }, alpha = if left > 0.2 then 1 else math.round((0.3 + (left / 0.2) * 0.7) * 8) / 8 }, function()
				ui:box({ direction = "row", gap = 6 }, function()
					ui:text(if toast.trigger then "Открытие:" else "Исследовано:")
					ui:text(kind.data.title, { color = COLORS.team })
				end)
				if #opens > 0 then
					ui:text("Теперь можно: " .. table.concat(opens, ", "), { color = COLORS.soft, wrap = room - 32 })
				end
			end) then
				c.shared.techOpen = true
			end
			ui:tip(id, "Дерево технологий (R)")
		end
	end)
end

-- Уведомления слева под полосой (alerts в hud.ts): строка цвета вида с маркером; щелчок ведёт камеру к месту. Со
-- временем гаснут.
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
				ui:text(alertsLib.TEXTS[alert.text] or alert.text, { color = color, shadow = COLORS.ink })
			end)
			ui:tip(id, "Показать место")
			if ui:clicked(id) then
				c.shared.flyTo = { x = alert.x, y = alert.y }
			end
		end
	end)
end

-- Остаток, каким игрок видел месторождение в последний раз (knownReserve.ts): пока видит хоть тайл — настоящий, в
-- тумане — прежний; так туман не выдаёт, копают ли его чужие. Ключ — сущность месторождения.
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

-- Что выйдет из месторождения и через что (chainOf): «Металлическая руда → Плавильня → Металл».
local function chainOf(c, resource: string): string
	local ore = goods.oreOf(c, resource)
	local refinery = "?"
	for _, kind in construction.menu(c) do
		if ore and kind.data.refines == ore then
			refinery = kind.data.title
			break
		end
	end
	local function title(name: string?): string
		local kind = name and c.protos.goods[name]
		return if kind then kind.data.title else "?"
	end
	return title(ore) .. " → " .. refinery .. " → " .. title(resource)
end

-- Подсказки у указателя над картой (hoverTips в hud.ts): месторождение — какое, сколько осталось и что из него выйдет;
-- своя труба или колодец — сколько зданий в сети и что в её хранилищах.
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
					ui:text("Месторождение: " .. widgets.lower(good.data.title))
					ui:text(if left == nil then "остаток неизвестен" elseif left > 0 then "осталось " .. math.floor(left) else "выработано", { color = COLORS.dim })
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
		if logistics.isStore(c, member) and logistics.isReady(c, c.player, member) then
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
		ui:text("Сеть: зданий " .. buildings)
		goodsRow(c, items, if capacity > 0 then "хранилища пусты" else "хранилищ нет")
	end)
end

function hud.draw(c)
	shownAlerts = alertsLib.update(c)
	alertList(c)
	stepsPanel(c)
	modeBar(c)
	rewards(c)
	topBar(c)
	hoverTips(c)
	bottomBar(c)
end

return hud
