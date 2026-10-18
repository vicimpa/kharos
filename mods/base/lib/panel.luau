--!strict
-- Панель игрока по кускам: сетку команд и сведения о выбранном собирают механики, ui/hud их только раскладывает. Кусок —
-- поле panel любого вида:
--
--   panel = {
--     slots = { { at = 50, fill = function(c, list, view) … end } },  -- ячейки сетки: list[1..12] = ячейка
--     info = { { at = 220, draw = function(c, view) … end } },        -- строки сведений, шириной view.width
--     overlay = { { at = 60, draw = function(c, view) … end } },      -- поверх поля: подсказки, окна
--   }
--
-- Куски идут по at, при равенстве — по имени вида. view сетки: selection, builders — свои строители среди выбранного,
-- root — сетка на корне (кусок, открывший свою страницу, ставит false; дальше куски корня молчат), exclusive — кусок,
-- который забирает сетку целиком (подтверждение), кладёт туда свой list. view сведений: selection, first, kind, many,
-- site (стройка первого), built (готовое здание, выбранное одно), width. Поверх поля куски встают между частями самой
-- панели (lib/panel.LAYERS); view у них общий на кадр: tip — подсказка у указателя уже показана.
--
-- Ячейка: label, picture (вид), title и about (карточка), cost и gain, materials со stock, power и idle, count, unit,
-- active, disabled, short, hint (подсказка шага), fresh и seen (новая кнопка), lamp, zones, run — что делает щелчок.

local economy = require("lib/economy")
local goods = require("lib/goods")
local steps = require("lib/steps")
local widgets = require("lib/widgets")

local panel = {}

-- Постоянные места сетки: превращение, отмена, разбор и «Назад»; выключатель — на месте «Назад»; улучшение здания —
-- конец второго ряда корня: у зданий, которые улучшают, списков там нет.
panel.CONVERT, panel.CANCEL, panel.DEMOLISH, panel.BACK = 9, 10, 11, 12
panel.SWITCH = panel.BACK
panel.UPGRADE = 8

-- Места частей самой панели среди кусков поверх поля: уведомления, первые шаги, полоса режима, награды, верхняя полоса,
-- нижняя панель. Подсказки над картой — между верхней и нижней, окна — после нижней.
panel.LAYERS = { alerts = 10, steps = 20, mode = 30, rewards = 40, top = 50, bottom = 70 }
-- Высота верхней полосы.
panel.TOP = 38

-- Сторона значка в ячейке и в очереди производства.
panel.TILE = 32
panel.QUEUED = 24

-- Доля процентом.
function panel.percent(value: number): string
	return math.floor(value * 100 + 0.5) .. "%"
end

-- Число до сотых, без лишних нулей.
function panel.number(value: number): string
	local rounded = math.round(value * 100) / 100
	if rounded == math.floor(rounded) then
		-- + 0: отрицательный ноль — просто ноль.
		return tostring(math.floor(rounded) + 0)
	end
	return (string.gsub(string.format("%.2f", rounded), "0+$", ""))
end

-- Подсказка у указателя над картой: тайл под ним и где встать подсказке; nil — указатель не над картой или подсказка
-- уже показана.
function panel.hover(c, view): (number?, number?, { [string]: number }?)
	local input = c.input
	if view.tip or not input.inside or input.over_ui then
		return nil, nil, nil
	end
	local width = c.ui.width
	local anchor = if input.x > width - 260 then { right = width - input.x + 16, top = input.y + 16 } else { left = input.x + 16, top = input.y + 16 }
	return math.floor(input.wx), math.floor(input.wy), anchor
end

-- Энергия сети для подписи: выработка повреждённых станций дробная — до десятых и вниз, а спрос — вверх, чтобы нехватка
-- не выглядела как «20 из 20».
function panel.gridState(e: economy.Economy)
	return {
		produced = math.floor(e.produced * 10) / 10,
		demand = math.ceil(e.demand * 10 - 1e-9) / 10,
		peak = math.ceil(e.peak * 10 - 1e-9) / 10,
		stored = math.round(e.stored * 100) / 100,
		overload = economy.overloadOf(e) > 0,
	}
end

-- Подпись энергии сети.
function panel.gridText(c, grid): string
	local number = panel.number
	return c:t("hud.zonePower", { demand = number(grid.demand), produced = number(grid.produced) })
		.. (if grid.stored > 0 then c:t("hud.zoneStored", { stored = number(grid.stored) }) else "")
		.. (if grid.peak > grid.demand then c:t("hud.zonePeak", { peak = number(grid.peak) }) else "")
		.. (if grid.overload then c:t("hud.overloaded") else "")
end

-- Текущий первый шаг новичка (lib/steps): его кнопки подсвечены; nil — пройдены все.
function panel.currentStep(c)
	return steps.of(c).step
end

-- Свои строители среди выбранного.
function panel.builders(c, selection): { number }
	local list = {}
	for _, e in selection do
		if c:mine(e) and c:has(e, "Unit") and c:has(e, "Repair") then
			table.insert(list, e)
		end
	end
	return list
end

-- «Назад» на своём месте.
function panel.back(c, list, run: () -> ())
	list[panel.BACK] = { label = c:t("common.back"), run = run }
end

-- Значок груза с количеством.
function panel.goodWith(c, good: string, amount: number?, size: number?, of: number?)
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
function panel.stockHint(c, label: string, good: string, have: number, capacity: number, note: string, tone: string, width: number)
	local ui = c.ui
	ui:box({ direction = "row", align = "center", gap = 6, width = width }, function()
		ui:text(label .. ":", { color = tone })
		panel.goodWith(c, good, have, 20, capacity)
	end)
	-- Пояснение в словаре продолжает строку с запасом («. Расстреляет…», « — пусто…»): здесь оно со своей строки.
	ui:text(widgets.capital((string.gsub(note, "^[%s%.—]+", ""))), { color = tone, wrap = width })
end

-- Груз списком значков: что лежит, по порядку грузов.
function panel.goodsRow(c, items: { [string]: number }, empty: string?)
	local ui = c.ui
	ui:box({ direction = "row", align = "center", gap = 8 }, function()
		local any = false
		for _, name in goods.names(c) do
			local amount = items[name] or 0
			if amount >= 1 then
				panel.goodWith(c, name, amount, 20)
				any = true
			end
		end
		if not any and empty then
			ui:text(empty)
		end
	end)
end

export type Part = { at: number, source: string, fn: (...any) -> () }

-- Режимы наведения (c.shared.mode) по видам: их описывает управление, которое их ведёт, полем modes —
-- { describe(c, режим) → название, что делать; done(c)? — кнопка «Готово» }.
local modes = setmetatable({}, { __mode = "k" }) :: { [any]: { [string]: any } }

function panel.mode(protos, kind: string)
	local found = modes[protos]
	if not found then
		found = {}
		for _, list in protos do
			for _, other in list do
				if type(other) == "table" and type(other.modes) == "table" then
					for name, spec in other.modes do
						found[name] = spec
					end
				end
			end
		end
		modes[protos] = found
	end
	return found[kind]
end

-- Куски панели по полю (slots или info) со всех видов: по at, при равенстве — по разделу и имени вида.
local collected = setmetatable({}, { __mode = "k" }) :: { [any]: { [string]: { Part } } }

function panel.parts(protos, field: string): { Part }
	local byField = collected[protos]
	if not byField then
		byField = {}
		collected[protos] = byField
	end
	local found = byField[field]
	if found then
		return found
	end
	local list: { Part } = {}
	for section, kinds in protos do
		for name, kind in kinds do
			local parts = type(kind) == "table" and type(kind.panel) == "table" and kind.panel[field]
			for _, part in parts or {} do
				table.insert(list, { at = part.at, source = section .. "/" .. name, fn = part.fill or part.draw })
			end
		end
	end
	table.sort(list, function(a, b)
		if a.at ~= b.at then
			return a.at < b.at
		end
		return a.source < b.source
	end)
	byField[field] = list
	return list
end

return panel
