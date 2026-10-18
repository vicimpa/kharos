--!strict
-- Общие кусочки панелей — перенос packages/client/src/gui/widgets.ts: цвета текста, тень подписей, монета, полоса
-- готовности, подпись клавиши.

local widgets = {}

-- Цвета текста — те же, что у страницы (style.css).
widgets.COLORS = {
	ink = "#0b111b",
	bright = "#eef6ff",
	text = "#d6e6f5",
	soft = "#b4c9dd",
	dim = "#8fa9c2",
	muted = "#6184a3",
	team = "#5aa9ff",
	teamMid = "#1f63d8",
	teamDark = "#10358f",
	gold = "#f0c95a",
	good = "#8fe0a8",
	warn = "#ffb070",
	bad = "#ff7a66",
	power = "#8fd0ff",
	ally = "#4ec973",
	well = "#070d15",
	steel = "#41617f",
}

local COLORS = widgets.COLORS

-- Тень подписей кнопок и ячеек: пиксель чернил правее и ниже.
function widgets.shadow(extra: { [string]: any }?): { [string]: any }
	local style = { shadow = COLORS.ink, lift = 1 }
	for key, value in extra or {} do
		style[key] = value
	end
	return style
end

-- Монета кредитов.
function widgets.coin(ui, size: number?)
	ui:image("coin", size or 16, size or 16)
end

-- Полоса готовности с подписью: утопленное окно, внутри — полоса огней команды на долю value, поверх — подпись.
-- Срок для интерфейса: минуты и секунды, от часа — часы, минуты и секунды (clockOf).
function widgets.clock(seconds: number): string
	local whole = math.floor(seconds + 0.5)
	if whole < 3600 then
		return string.format("%d:%02d", whole // 60, whole % 60)
	end
	return string.format("%d:%02d:%02d", whole // 3600, (whole % 3600) // 60, whole % 60)
end

function widgets.bar(ui, value: number, label: string, width: number?)
	local fill = math.clamp(value, 0, 1)
	ui:box({ skin = "well", width = width, height = 24, padding = 4, direction = "stack", clip = true }, function()
		-- В widgets.ts у ряда нет align = "stretch", и заливка там нулевой высоты — полоса пустая; здесь она видна.
		ui:box({ grow = 1, direction = "row", align = "stretch" }, function()
			ui:box({ grow = fill, background = COLORS.teamMid })
			ui:box({ grow = 1 - fill })
		end)
		ui:box({ self = { "start", "center" }, padding = { 0, 8 } }, function()
			ui:text(label, widgets.shadow({ color = COLORS.text, ellipsis = true }))
		end)
	end)
end

-- Подпись клавиши — золотая.
function widgets.key(ui, label: string, color: string?)
	ui:text(label, widgets.shadow({ color = color or COLORS.gold }))
end

-- Строка словаря вокруг подстановки, на месте которой рисуется не текст (значки грузов — rich в TS): что до «{name}»
-- и что после. Подстановки нет — всё до.
function widgets.split(text: string, name: string): (string, string)
	local from, to = string.find(text, "{" .. name .. "}", 1, true)
	if not from then
		return text, ""
	end
	return string.sub(text, 1, from - 1), string.sub(text, to + 1)
end

-- С заглавной первой буквы: латиница, латиница с надстрочными, кириллица (и украинские і, ї, є, ґ).
function widgets.capital(text: string): string
	local first = utf8.codepoint(text, 1, 1)
	if not first then
		return text
	end
	local upper = first
	if (first >= 0x61 and first <= 0x7A) or (first >= 0xE0 and first <= 0xFE and first ~= 0xF7) or (first >= 0x430 and first <= 0x44F) then
		upper = first - 0x20
	elseif first >= 0x450 and first <= 0x45F then
		upper = first - 0x50
	elseif first == 0x491 then
		upper = 0x490
	end
	return utf8.char(upper) .. string.sub(text, utf8.offset(text, 2) or #text + 1)
end

-- Строчными, с кириллицей (toLowerCase в TS): string.lower меняет только латиницу.
function widgets.lower(text: string): string
	local out = {}
	for _, code in utf8.codes(text) do
		if code >= 0x410 and code <= 0x42F then
			code += 0x20
		elseif code == 0x401 then
			code = 0x451
		elseif code >= 0x41 and code <= 0x5A then
			code += 0x20
		end
		table.insert(out, utf8.char(code))
	end
	return table.concat(out)
end

return widgets
