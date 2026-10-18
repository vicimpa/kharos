--!strict
-- Панель игрока — перенос packages/client/src/gui/hud.ts (верхняя полоса) и gui/bar.ts (нижняя: мини-карта,
-- сведения о выбранном, сетка команд 4 × 3). Те же размеры, рамки скина, шрифты и цвета.

local widgets = require("lib/widgets")
local stats = require("lib/stats")
local conversion = require("lib/conversion")
local construction = require("lib/construction")
local kinds = require("lib/kinds")
local economy = require("lib/economy")
local goods = require("lib/goods")
local logistics = require("lib/logistics")
local research = require("lib/research")
local tactics = require("lib/tactics")
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
local SWITCH = BACK
-- Названия инструментов протяжки: стена и ворота — как здание (toolName).
local TOOL_NAMES = { pipe = "Труба", well = "Колодцы" }
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
		return tostring(math.floor(rounded))
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
		if ui:button("tech", { active = c.shared.techOpen == true, padding = { 2, 10 }, height = 30 }, function()
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
	local paving = if mode ~= nil and mode.kind == "paving" then mode.tool else nil
	-- Трубы и колодцы открывают исследования: раздел «Логистика» — с первым открытым инструментом.
	local tools = {}
	for _, tool in { "pipe", "well" } do
		local kind = c.protos.buildings[tool]
		if kind and construction.researched(c, c.player, kind.data.research) then
			table.insert(tools, kind)
		end
	end
	local free = construction.freeCredits(c, c.player)
	local options = {}
	for _, kind in construction.menu(c) do
		if construction.unlocked(c, c.player, kind) then
			table.insert(options, kind)
		end
	end
	if page.name == "root" then
		for i, section in SECTIONS do
			local count = 0
			for _, kind in options do
				if sectionOf(kind.name) == section.page then
					count += 1
				end
			end
			-- Раздел появляется, когда в нём открыто хоть одно здание; закрытый оставляет пустую ячейку.
			if count > 0 then
				list[i] = {
					label = section.label,
					picture = c.protos.buildings[section.picture],
					title = section.tip,
					count = count,
					run = function()
						page.name = section.page
					end,
				}
			end
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
	if page.name == "logistics" then
		local tips = {
			pipe = "Связывает в сеть здания, стоящие поодаль (одинаковые здания вплотную связаны и без трубы): по трубам идут груз и энергия, они расширяют зону. Перекрывает проезд — под проездом веди колодцами. Своя зона не нужна. Тяни мышью линию",
			well = "Колодцы — концы подземной трубы: щелчок ставит один (свяжется с колодцем по прямой), протяжка — пару, до 10 тайлов. Над ней ездят и строят, уязвимы только колодцы. Своя зона не нужна",
		}
		for i, kind in tools do
			local active = paving == kind.name
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
				if paving then
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
			run = function()
				c.shared.mode = if placing == kind.name then nil else { kind = "placing", building = kind.name }
			end,
		}
		-- Стену и ворота не ставят по одной, а тянут мышью линией, как трубу: их кнопка включает протяжку (wallSlot).
		if kind.name == "wall" or kind.name == "gate" then
			local slot = list[index]
			local active = paving == kind.name
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
			if placing or paving then
				c.shared.mode = nil
			end
			page.name = "root"
		end,
	}
end

-- Ячейки сетки команд для выбранного: у строителей — стройка, у своего завода — заказ юнитов, у MCV и главного
-- здания — превращение, у своей стройки — отмена, у готового здания — разбор.
local function slots(c, selection)
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
		for _, name in kind.data.produces or {} do
			local unit = c.protos.units[name]
			if unit then
				table.insert(list, {
					label = unit.data.title or name,
					picture = unit,
					cost = unit.data.cost,
					materials = unit.data.materials,
					c = c,
					stock = (logistics.stockOf(c, c.player)),
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
			refund += construction.refundOf(kinds.of(c, e)) + construction.prepaidOf(c, e)
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
	if #switchable > 0 and page.name == "root" and not list[SWITCH] then
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
	if #demolish > 0 and page.name == "root" then
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
				elseif hauler.to >= 0 and c:alive(hauler.to) then
					local kind = c.protos.goods[hauler.resource]
					local name = string.lower(if kind then kind.data.title else hauler.resource)
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
			elseif stock and built then
				ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
					ui:text((if kind.data.stores then "Хранилище" else "Склад") .. ":")
					goodsRow(c, stock.items, "пусто")
					ui:text("— вмещает " .. stock.capacity .. (if (stock.reserve or 0) > 0 then ", резерв " .. stock.reserve else ""), { color = COLORS.dim })
				end)
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
	patrolling = { name = "Патруль", tip = "Щёлкни, докуда патрулировать; с Shift — ещё точка" },
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
	local room = ui.width - 24
	ui:box({ anchor = { centerX = 0, top = TOP_HEIGHT + 6 } }, function()
		ui:box({ id = "mode", skin = "panel", padding = { 10, 12, 10, 16 }, direction = "row", align = "center", gap = 12, maxWidth = room }, function()
			local building = mode.building and c.protos.buildings[mode.building]
			local name = building and building.data.title or ""
			local tip = spec.tip
			if mode.kind == "paving" then
				local tool = c.protos.buildings[mode.tool]
				name = TOOL_NAMES[mode.tool] or (tool and tool.data.title) or mode.tool
				local paving = c.shared.paving
				if paving and paving.tiles > 0 then
					tip = "Тяни по карте: " .. paving.tiles .. " тайл., " .. paving.cost .. " кредитов"
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

function hud.draw(c)
	modeBar(c)
	rewards(c)
	topBar(c)
	bottomBar(c)
end

return hud
