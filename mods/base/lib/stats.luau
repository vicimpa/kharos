--!strict
-- Параметры вида юнита для карточек и панели: строки собираются из данных вида, а не пишутся текстом — поменяются
-- числа, поменяется и карточка. Оружейных строк пока нет.

local stats = {}

-- Подписи и классы — ключи словаря (lang).
stats.LABELS = {
	hp = "stats.hp",
	class = "stats.class",
	speed = "stats.speed",
	sight = "stats.sight",
	cargo = "stats.cargo",
	repair = "stats.repair",
}

stats.CLASSES = {
	infantry = "stats.vs.infantry",
	vehicle = "stats.vs.vehicle",
	heavy = "stats.vs.heavy",
	air = "stats.vs.air",
	building = "stats.vs.building",
}

-- До одного знака после запятой, без хвостового нуля.
local function tidy(value: number): string
	local rounded = math.round(value * 10) / 10
	return if rounded == math.floor(rounded) then tostring(math.floor(rounded)) else tostring(rounded)
end

export type Row = { key: string, label: string, value: string }

-- Строки параметров вида: прочность, класс, скорость, обзор, груз, ремонт.
function stats.unit(c, kind): { Row }
	local d = kind.data or {}
	local rows: { Row } = {}
	local function row(key: string, value: string)
		table.insert(rows, { key = key, label = c:t(stats.LABELS[key]), value = value })
	end
	if d.hp then
		row("hp", tostring(d.hp))
	end
	if d.kind then
		row("class", if stats.CLASSES[d.kind] then c:t(stats.CLASSES[d.kind]) else d.kind)
	end
	if d.speed then
		row("speed", tidy(d.speed))
	end
	if d.sight then
		row("sight", tidy(d.sight))
	end
	if d.inventory then
		row("cargo", tostring(d.inventory))
	end
	if d.repair then
		row("repair", tidy(d.repair))
	end
	return rows
end

-- Параметры одним текстом, строка на параметр: для всплывающей подсказки.
function stats.text(c, kind): string
	local lines = {}
	for _, row in stats.unit(c, kind) do
		table.insert(lines, row.label .. ": " .. row.value)
	end
	return table.concat(lines, "\n")
end

-- Главное одной строкой — для панели выбранного.
function stats.line(c, kind): string
	local brief = { hp = true, speed = true, sight = true, cargo = true, damage = true, range = true }
	local parts = {}
	for _, row in stats.unit(c, kind) do
		if brief[row.key] then
			table.insert(parts, row.label .. " " .. row.value)
		end
	end
	return table.concat(parts, " · ")
end

return stats
