--!strict
-- Стройка на панели: у строителей — разделы стройки и инструменты протяжки, у своей стройки — отмена, у готовых своих
-- зданий — разбор; в сведениях — как идёт стройка, сколько стоит починка и что умеет строитель.

local construction = require("lib/construction")
local earthworks = require("lib/earthworks")
local economy = require("lib/economy")
local kinds = require("lib/kinds")
local levels = require("lib/levels")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local paving = require("lib/paving")
local seenLib = require("lib/seen")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS
local percent = panel.percent

-- Названия инструментов протяжки.
local TOOL_NAMES = require("controls/stroke").TOOL_NAMES
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
-- Разделы строителя по порядку кнопок, с картинкой здания. Здание входит в раздел своим data.section, без него — в
-- хозяйство.
local SECTIONS = {
	{ page = "economy", label = "grid.sections.economy", tip = "grid.sectionTips.economy", picture = "generator" },
	{ page = "storage", label = "grid.sections.storage", tip = "grid.sectionTips.storage", picture = "metalYard" },
	{ page = "industry", label = "grid.sections.industry", tip = "grid.sectionTips.industry", picture = "smelter" },
	{ page = "production", label = "grid.sections.production", tip = "grid.sectionTips.production", picture = "blockPlant" },
	{ page = "military", label = "grid.sections.military", tip = "grid.sectionTips.military", picture = "factory" },
	{ page = "defense", label = "grid.sections.defense", tip = "grid.sectionTips.defense", picture = "wall" },
}

-- Раздел здания.
local function sectionOf(kind): string
	return kind.data.section or "economy"
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
	local step = panel.currentStep(c)
	if page.name == "root" then
		for i, section in SECTIONS do
			local count, hint, fresh = 0, false, false
			for _, kind in options do
				if sectionOf(kind) == section.page then
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
			list[panel.DEMOLISH] = {
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
		list[panel.BACK] = {
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
		list[panel.BACK] = {
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
		if sectionOf(kind) ~= page.name or index >= panel.BACK - 1 then
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
	list[panel.BACK] = {
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


-- Сетка строителей; без них страница сетки строителя — снова корень.
local function builders(c, list, view)
	if #view.builders > 0 then
		constructionSlots(c, list, view.selection)
	else
		page.name, page.key = "root", ""
	end
	if page.name ~= "root" then
		view.root = false
	end
end

-- Своя стройка: отменить её или разбор; отменённую уже разбирают — передумать нельзя.
local function cancel(c, list, view)
	local selection = view.selection
	local site = #selection == 1 and c:mine(selection[1]) and c:get(selection[1], "Site")
	if site and not site.undo then
		local e = selection[1]
		list[panel.DEMOLISH] = {
			label = if site.demolish then c:t("grid.cancelDemolish") else c:t("grid.cancelBuild"),
			run = function()
				c:send("cancelBuild", { site = e })
			end,
		}
	end
end

-- Готовые свои здания — разобрать за половину цены и оплаченное вперёд.
local function demolish(c, list, view)
	local buildings, refund = {}, 0
	for _, e in view.selection do
		if construction.canDemolish(c, c.player, e) then
			table.insert(buildings, e)
			refund += construction.refundOf(kinds.of(c, e), levels.of(c, e)) + construction.prepaidOf(c, e)
		end
	end
	if #buildings > 0 and view.root then
		list[panel.DEMOLISH] = {
			label = c:t("grid.remove"),
			cost = refund,
			gain = true,
			title = c:t("grid.demolishTip"),
			run = function()
				for _, e in buildings do
					c:send("demolish", { building = e, builders = {} })
				end
			end,
		}
	end
end

-- Как идёт стройка или разбор.
local function progress(c, view)
	local site, first = view.site, view.first
	if not site then
		return
	end
	local value = math.min(1, site.progress / site.total)
	local label
	if site.demolish then
		label = if value < 1 then c:t("hud.demolishing", { percent = percent(value) }) else c:t("hud.waitsToDemolish")
	elseif c:has(first, "Footprint") then
		label = if c:mine(first) and construction.short(c, c.player)[first] then c:t("hud.buildingBroke", { percent = percent(value) }) else c:t("hud.building", { percent = percent(value) })
	else
		label = if site.blocked then c:t("hud.blocked") else c:t("hud.waitsBuilder")
	end
	widgets.bar(c.ui, value, label, view.width)
end

-- Своё повреждённое: сколько стоит починка (у стройки прочность — та же доля, что полоса стройки).
local function repair(c, view)
	local first = view.first
	local health = not view.many and not view.site and c:mine(first) and c:get(first, "Health")
	if health and health.value < health.max and construction.isRepairable(c, first) then
		local cost = construction.repairCostOf(view.kind.data.cost, health.value, construction.rules(c).repairCost, health.max)
		c.ui:text(c:t("hud.health", { percent = percent(health.value / health.max), repair = cost }), { color = COLORS.soft, wrap = view.width })
	end
end

-- Что умеет строитель, пока не выбирают место.
local function builderTip(c, view)
	local mode = c.shared.mode
	if #panel.builders(c, view.selection) > 0 and not (mode and mode.kind == "placing") then
		c.ui:text(c:t("hud.builderTip"), { color = COLORS.soft, wrap = view.width })
	end
end

return {
	slots = { { at = 10, fill = builders }, { at = 90, fill = cancel }, { at = 130, fill = demolish } },
	info = { { at = 30, draw = progress }, { at = 80, draw = repair }, { at = 230, draw = builderTip } },
}
