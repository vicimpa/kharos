--!strict
-- Выбор места под здание: кнопка здания в сетке строителя включает режим c.shared.mode = { kind = "placing", building
-- }. Под указателем — призрак здания серединой в тайле и рамка основания, зелёная там, где его можно заложить, и
-- красная, где нельзя; шахта сама встаёт на разведанное месторождение рядом. Щелчок закладывает и режим оставляет —
-- можно ещё и ещё; правая кнопка и Esc — отмена; без выбранных строителей режим кончается сам. Пока выбирают место,
-- держат Alt или смотрят кнопку здания (c.shared.zonesHover) — видны границы зон: свои синим, чужие красным, и круг,
-- которым здание расширит свою. На сенсорном экране призрак появляется под пальцем, идёт за ним, а отпущенный палец
-- закладывает здание: наведения нет, и место видно до того, как его выбрали.

local construction = require("lib/construction")
local placement = require("lib/placement")
local zones = require("lib/zones")
local depositsLib = require("lib/deposits")
local conversion = require("lib/conversion")

local build = {}

build.data = {
	-- Сдвиг указателя, после которого щелчок уже не щелчок, в пикселях.
	threshold = 6,
	-- С какого расстояния от указателя до центра месторождения шахта сама встаёт на него, в тайлах.
	snap = 3,
	-- Сколько точек пунктира на круге радиуса главного здания и их сторона в пикселях.
	dashes = 120,
	dash = 3,
}

-- Призрак места, с предумноженной альфой; обводка основания и границы зон.
local GHOST = { 0.7, 0.7, 0.7, 0.7 }
local FORBIDDEN_GHOST = { 0.7, 0.14, 0.1, 0.7 }
local ALLOWED = 0x59ff73
local FORBIDDEN = 0xff4d40
local CONTROL = 0x4d99ff
local BORDER_ALPHA, FAINT_ALPHA = 0.85, 0.5

local pressed: { x: number, y: number }? = nil

-- Выбраны ли свои строители: место под здание выбирают ими.
local function builders(c): { number }
	local list = {}
	for _, e in c.shared.selection or {} do
		if c:alive(e) and c:mine(e) and c:has(e, "Unit") and c:has(e, "Repair") then
			table.insert(list, e)
		end
	end
	return list
end

-- Место под указателем: левый верхний тайл основания серединой под ним и годится ли оно. Шахта липнет к месторождению
-- рядом, если игрок его разведал: иначе выдала бы, где оно.
local function placementOf(c, kind): (number, number, boolean)
	local data = kind.data
	local tx, ty = math.floor(c.input.wx), math.floor(c.input.wy)
	local x, y = tx - math.floor(data.width / 2), ty - math.floor(data.height / 2)
	if data.extract and data.width == depositsLib.SIZE then
		local best = build.data.snap
		for _, e in c:each({ "Deposit", "Position" }) do
			local at = c:get(e, "Position")
			local distance = math.sqrt((at.x - tx - 0.5) ^ 2 + (at.y - ty - 0.5) ^ 2)
			if distance <= best and c:knows(e) then
				best = distance
				x, y = at.x - depositsLib.SIZE / 2, at.y - depositsLib.SIZE / 2
			end
		end
	end
	return x, y, construction.canBuild(c, c.player, kind, x, y)
end

-- Радиус, на котором точек пунктира — dashes: зона главного здания; на других кругах шаг тот же.
local function reference(c): number
	return conversion.building(c).data.zone or 12
end

-- Точки внешней границы кругов: точки каждого круга, не накрытые другими.
local function outlineOf(circles: { number }, span: number): { number }
	local dots = {}
	for i = 1, #circles, 3 do
		local cx, cy, radius = circles[i], circles[i + 1], circles[i + 2]
		local dashes = math.round(build.data.dashes * radius / span)
		for dash = 0, dashes - 1 do
			local angle = dash / dashes * math.pi * 2
			local x, y = cx + math.cos(angle) * radius, cy + math.sin(angle) * radius
			local covered = false
			for j = 1, #circles, 3 do
				if j ~= i and math.sqrt((x - circles[j]) ^ 2 + (y - circles[j + 1]) ^ 2) < circles[j + 2] - 0.01 then
					covered = true
					break
				end
			end
			if not covered then
				table.insert(dots, x)
				table.insert(dots, y)
			end
		end
	end
	return dots
end

-- Границы зон считаются заново, только когда сменились круги или игрок.
local cache: { key: string, own: { number }, foreign: { number }, circles: { number } }? = nil

local function bordersOf(c)
	local all = zones.all(c)
	local parts = { tostring(c.player) }
	local players = {}
	for player in all do
		table.insert(players, player)
	end
	table.sort(players)
	for _, player in players do
		table.insert(parts, player .. ":" .. table.concat(all[player], ","))
	end
	local key = table.concat(parts, ";")
	if cache and cache.key == key then
		return cache
	end
	local foreign = {}
	for _, player in players do
		if player ~= c.player then
			for _, value in outlineOf(all[player], reference(c)) do
				table.insert(foreign, value)
			end
		end
	end
	cache = { key = key, own = outlineOf(all[c.player] or {}, reference(c)), foreign = foreign, circles = all[c.player] or {} }
	return cache
end

local function dots(c, list: { number }, color: number, alpha: number)
	local size = build.data.dash / c.camera.zoom
	local left, top = c:to_world(0, 0)
	local right, bottom = c:to_world(c.screen.w, c.screen.h)
	for i = 1, #list, 2 do
		local x, y = list[i], list[i + 1]
		if x > left - size and x < right + size and y > top - size and y < bottom + size then
			c.draw:rect(x - size / 2, y - size / 2, x + size / 2, y + size / 2, color, nil, alpha)
		end
	end
end

-- Круг, которым здание расширит зону: та его часть, что выходит за нынешние зоны.
local function expansion(c, kind, x: number, y: number, circles: { number })
	local data = kind.data
	local radius = if data.isolated then 0 else (data.zone or data.expand or zones.EXPAND_RADIUS)
	if radius <= 0 then
		return
	end
	local cx, cy = x + data.width / 2, y + data.height / 2
	local added = {}
	local dashes = math.round(build.data.dashes * radius / reference(c))
	for dash = 0, dashes - 1 do
		local angle = dash / dashes * math.pi * 2
		local px, py = cx + math.cos(angle) * radius, cy + math.sin(angle) * radius
		if not zones.inCircles(circles, px, py) then
			table.insert(added, px)
			table.insert(added, py)
		end
	end
	dots(c, added, CONTROL, FAINT_ALPHA)
end

function build.update(c)
	local shared, input = c.shared, c.input
	local mode = shared.mode
	local placing = mode ~= nil and mode.kind == "placing"
	local hover = shared.zonesHover
	shared.zonesHover = nil
	if (placing or hover or input.keys.alt) and not shared.paused then
		local borders = bordersOf(c)
		dots(c, borders.own, CONTROL, BORDER_ALPHA)
		dots(c, borders.foreign, FORBIDDEN, BORDER_ALPHA)
	end
	if not placing then
		pressed = nil
		return
	end
	local kind = c.protos.buildings[mode.building]
	local units = builders(c)
	if not kind or #units == 0 then
		shared.mode = nil
		return
	end
	if shared.paused then
		pressed = nil
		return
	end
	-- Esc сначала снимает режим, и только следующим нажатием — выделение.
	if input.hits.escape then
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	if input.pressed.right and input.inside and not input.over_ui then
		-- Тот же щелчок приказом уже не станет (controls/orders).
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	local x, y, allowed = placementOf(c, kind)
	-- Касание: призрак — только пока палец на карте.
	local touching = input.touch and pressed ~= nil and input.down.left
	if input.inside and (touching or not input.touch) then
		local data = kind.data
		c:show(kind, placement.middle(x, data.width), placement.middle(y, data.height), { tint = if allowed then GHOST else FORBIDDEN_GHOST, over = true })
		c.draw:rect(x, y, x + data.width, y + data.height, if allowed then ALLOWED else FORBIDDEN, 2, BORDER_ALPHA)
		if allowed then
			expansion(c, kind, x, y, bordersOf(c).circles)
		end
	end
	if input.pressed.left and input.inside and not input.over_ui then
		pressed = { x = input.x, y = input.y }
	end
	if pressed and input.released.left then
		-- Мышью протяжка — не щелчок; пальцем тянут сам призрак, и место — там, где отпустили.
		local dragged = math.abs(input.x - pressed.x) + math.abs(input.y - pressed.y) > build.data.threshold
		pressed = nil
		if (dragged and not input.touch) or input.over_ui then
			return
		end
		if allowed then
			c:send("build", { building = mode.building, x = x, y = y, builders = units, queue = c.input.keys.shift })
		else
			c:sound("deny", { volume = 0.35 })
		end
	end
end

-- Полоса режима (ui/hud): какое здание ставят и что делать.
build.modes = {
	placing = {
		describe = function(c, mode)
			local building = mode.building and c.protos.buildings[mode.building]
			return c:t("mode.placing", { name = building and c:t(building.data.title) or "" }), c:t(if c.input.touch then "mode.tips.placingTouch" else "mode.tips.placing")
		end,
	},
}

return build
