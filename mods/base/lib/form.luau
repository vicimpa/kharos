--!strict
-- Поля окон меню — перенос packages/client/src/gui/form.ts: окно с заголовком и подвалом, кнопки, ползунок, флажок,
-- ряд вариантов с переносом, числовое и текстовое поле, раскрывающийся блок, подпись слева от поля. Вид — тот же.

local widgets = require("lib/widgets")
local COLORS, shadow = widgets.COLORS, widgets.shadow

local form = {}

-- Рамка кнопки страницы: border в 4 пикселя поверх отступа.
local FRAME = 4

export type ButtonOptions = {
	primary: boolean?,
	danger: boolean?,
	active: boolean?,
	disabled: boolean?,
	grow: number?,
	width: number?,
	tip: string?,
	height: number?,
	padding: { number }?,
}

-- Кнопка меню: высота 32, текст с тенью. primary — главное действие окна, danger — опасное. Возвращает щелчок.
function form.button(ui, id: string, label: string, options: ButtonOptions?)
	local o: ButtonOptions = options or {}
	local skin = if o.danger then "danger" elseif o.primary then "button-primary" else nil
	local color = if o.disabled then COLORS.muted elseif o.primary or o.danger or o.active then COLORS.bright else COLORS.text
	local padding = o.padding or { 4, 12 }
	-- Отступ — как у кнопки страницы: свой и рамка в 4 пикселя. Подпись шире кнопки сокращается многоточием.
	local click = ui:button(id, {
		skin = skin,
		active = o.active,
		disabled = o.disabled,
		grow = o.grow,
		width = o.width,
		height = o.height or 32,
		padding = { padding[1], padding[2] + FRAME },
		alpha = if o.disabled then 0.6 else nil,
	}, function()
		ui:text(label, shadow({ color = color, ellipsis = true }))
	end)
	if o.tip then
		ui:tip(id, o.tip)
	end
	return click
end

-- Ширина кнопки с подписью — для переноса рядов.
function form.buttonWidth(ui, label: string, padding: number?): number
	return ui:measure(label) + 1 + ((padding or 12) + FRAME) * 2
end

export type WindowOptions = {
	id: string,
	title: string,
	width: number,
	-- Где окно: по умолчанию — посередине экрана.
	anchor: { [string]: number }?,
	maxHeight: number?,
	-- Кнопка «Назад» слева в подвале.
	back: string?,
	-- Кнопки действий справа в подвале; главное — последним.
	actions: (() -> ())?,
}

-- Окно меню: заголовок, содержимое и подвал — «Назад» слева, действия экрана справа. Окно не выше экрана: длинное
-- содержимое прокручивается внутри. Возвращает true, если нажали «Назад».
function form.window(ui, options: WindowOptions, body: () -> ()): boolean
	local back = false
	local anchor = options.anchor or { centerX = 0, centerY = 0 }
	-- Не ниже экрана: от верхнего края привязки до низа с полем в 16.
	local room = ui.height - (anchor.top or anchor.bottom or 16) - 16
	local maxHeight = math.min(options.maxHeight or room, room)
	ui:box({ id = options.id, anchor = anchor, width = options.width, maxHeight = maxHeight, skin = "panel", padding = 18, direction = "column", align = "stretch" }, function()
		ui:box({ padding = { 0, 0, 12, 0 }, direction = "row", justify = "center" }, function()
			ui:text(options.title, { font = "title", color = COLORS.dim, shadow = COLORS.ink, lift = 2, ellipsis = true })
		end)
		-- Тело уступает высоту, когда окну тесно: заголовок и подвал остаются на месте.
		ui:box({ id = options.id .. ":body", direction = "column", align = "stretch", gap = 10, scroll = true, minHeight = 48 }, body)
		if not options.back and not options.actions then
			return
		end
		-- Подвал отбит от тела отступом и чертой.
		ui:space(0, 14)
		ui:box({ height = 2, background = "#1c2b3e" })
		ui:box({ direction = "row", align = "center", gap = 6, padding = { 12, 0, 0, 0 }, wrap = true }, function()
			if options.back and form.button(ui, options.id .. ":back", options.back) then
				back = true
			end
			if options.actions then
				ui:box({ direction = "row", gap = 6, wrap = true, grow = 1, justify = "end" }, options.actions)
			end
		end)
	end)
	return back
end

-- Подпись поля слева и поле справа: подпись фиксированной ширины, с подсказкой.
function form.row(ui, label: string, labelWidth: number, control: () -> (), tip: string?, id: string?)
	ui:box({ direction = "row", align = "center", gap = 8 }, function()
		local labelId = id or ("label:" .. label)
		ui:box({ id = if tip then labelId else nil, width = labelWidth }, function()
			ui:text(label, { color = COLORS.dim, wrap = true })
		end)
		if tip then
			ui:tip(labelId, tip)
		end
		control()
	end)
end

-- Подпись над полем.
function form.above(ui, label: string, control: () -> ())
	ui:box({ direction = "column", align = "stretch", gap = 4 }, function()
		ui:text(label, { color = COLORS.dim, wrap = true })
		control()
	end)
end

export type SliderOptions = { min: number, max: number, step: number, width: number, disabled: boolean? }

-- Ползунок: дорожка в утопленном окне, заливка огней команды до ручки. Тянут или щёлкают — значение идёт за
-- указателем, по шагу step. Возвращает новое значение (или прежнее).
function form.slider(ui, id: string, value: number, options: SliderOptions): number
	local min, max, step, width = options.min, options.max, options.step, options.width
	local share = if max > min then math.clamp((value - min) / (max - min), 0, 1) else 0
	local inner = width - 8
	ui:box({ id = id, width = width, height = 20, skin = "well", padding = 4, direction = "row", alpha = if options.disabled then 0.5 else nil }, function()
		ui:box({ width = math.round(inner * share), height = 12, background = COLORS.teamMid })
		ui:box({ width = 4, height = 12, background = COLORS.bright })
	end)
	local held = not options.disabled and ui:held(id)
	if not held then
		return value
	end
	local raw = min + held[1] * (max - min)
	local stepped = math.round((raw - min) / step) * step + min
	return math.clamp(math.round(stepped * 1e6) / 1e6, min, max)
end

-- Флажок с подписью. Возвращает новое состояние.
function form.checkbox(ui, id: string, checked: boolean, label: string, disabled: boolean?): boolean
	ui:box({ id = id, direction = "row", align = "center", gap = 8, alpha = if disabled then 0.5 else nil }, function()
		-- Отмеченный — квадрат огней команды в утопленном окне.
		ui:box({ width = 18, height = 18, skin = "well", direction = "row", justify = "center", align = "center" }, function()
			if checked then
				ui:box({ width = 8, height = 8, background = COLORS.team })
			end
		end)
		ui:box({ shrink = true }, function()
			ui:text(label, { wrap = true })
		end)
	end)
	if not disabled and ui:clicked(id) then
		return not checked
	end
	return checked
end

export type ChipsSettings = { fill: boolean?, gap: number?, small: boolean?, tips: { string? }? }

-- Ряд вариантов: кнопки, выбранная нажата; не влезают в width — переносятся. fill — кнопки делят ширину строки
-- поровну. options — пары { значение, подпись }. Возвращает выбранное щелчком значение или nil.
function form.chips(ui, prefix: string, options: { { any } }, value: any, width: number, settings: ChipsSettings?): any
	local s: ChipsSettings = settings or {}
	local gap = s.gap or 6
	local padding = if s.small then 6 else 12
	local picked = nil
	local rows = { {} }
	local used = 0
	for index, option in options do
		local w = form.buttonWidth(ui, option[2], padding)
		local line = rows[#rows]
		if #line > 0 and used + gap + w > width then
			table.insert(rows, { { option, index } })
			used = w
		else
			table.insert(line, { option, index })
			used += (if #line > 1 then gap else 0) + w
		end
	end
	ui:box({ direction = "column", gap = if s.small then 2 else gap, width = width }, function()
		for _, line in rows do
			ui:box({ direction = "row", gap = if s.small then 2 else gap }, function()
				for _, entry in line do
					local option, index = entry[1], entry[2]
					local tip = if s.tips then s.tips[index] else nil
					local click = form.button(ui, prefix .. ":" .. (index - 1), option[2], { active = option[1] == value, grow = if s.fill then 1 else nil, height = if s.small then 24 else 32, padding = { 2, padding }, tip = tip })
					if click then
						picked = option[1]
					end
				end
			end)
		end
	end)
	return picked
end

-- Текстовое поле. Возвращает { value, focused, keys } — набранное (сразу, по буквам) и клавиши, отданные полем.
function form.textField(ui, id: string, value: string, options: { [string]: any }?)
	local o = table.clone(options or {})
	o.color = COLORS.bright
	return ui:input(id, value, o)
end

-- Числовое поле. Без live число уходит по каждой правке, с live — только по Enter или уходу фокуса. Возвращает новое
-- число или nil.
function form.numberField(ui, id: string, value: number, options: { width: number?, min: number?, max: number?, live: boolean? }?): number?
	local o = options or {}
	local field = ui:input(id, tostring(value), { width = o.width, digits = true, maxLength = 12, color = COLORS.bright })
	local commit = not o.live or table.find(field.keys, "Enter") ~= nil or table.find(field.keys, "Blur") ~= nil
	if not commit then
		return nil
	end
	local number = tonumber(field.value)
	if field.value == "" or number == nil then
		return nil
	end
	local clamped = math.clamp(number, o.min or -math.huge, o.max or math.huge)
	if clamped == value then
		return nil
	end
	return clamped
end

-- Раскрывающийся блок: строка-заголовок со стрелкой. Возвращает, открыт ли он теперь.
function form.details(ui, id: string, title: string, open: boolean, body: () -> ()): boolean
	ui:box({ id = id, direction = "row", gap = 6 }, function()
		ui:text((if open then "▾ " else "▸ ") .. title, { color = COLORS.dim, wrap = true })
	end)
	local nextOpen = if ui:clicked(id) then not open else open
	if open then
		body()
	end
	return nextOpen
end

-- Заголовок группы полей: мелкий, бледный, ПРОПИСНЫМИ, с чертой сверху (кроме первого).
function form.groupTitle(ui, title: string, first: boolean?)
	if not first then
		ui:box({ height = 2, background = "#1c2b3e" })
	end
	ui:box({ padding = { if first then 0 else 6, 0, 0, 0 } }, function()
		ui:text(ui:upper(title), { color = COLORS.muted })
	end)
end

-- Ссылка: открывает адрес в браузере.
function form.link(ui, app, id: string, label: string, url: string, center: boolean?)
	local color = if ui:hovered(id) then "#a5d0ff" else "#7fb7ff"
	ui:box({ id = id, direction = "row", justify = if center then "center" else "start" }, function()
		ui:text(label, { color = color, ellipsis = true })
	end)
	if ui:clicked(id) then
		app:open(url)
	end
end

return form
