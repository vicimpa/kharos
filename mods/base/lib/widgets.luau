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

return widgets
