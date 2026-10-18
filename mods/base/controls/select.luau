--!strict
-- Выделение: щелчок — своя сущность под курсором, рамка — свои юниты в ней, Shift — добавить, Esc — снять,
-- двойной щелчок — все свои того же вида на экране. Выделенное — c.shared.selection (его видят приказы и панели).

local select = {}

select.data = {
	-- Сдвиг указателя, после которого щелчок становится рамкой, в пикселях.
	threshold = 6,
	-- Двойной щелчок — за столько секунд.
	double = 0.35,
}

-- Вид отметок — как selectionPass.ts: приглушённый зелёный, яркость из настроек (0,7 по умолчанию).
local SELECTED = 0x73eb8c
local settings = require("lib/settings")
local RING_MARGIN = 0.2
local BOX_FILL_ALPHA = 0.12
local HIT_ALPHA = 0.5
local PATH_DOT, PATH_GAP, PATH_ALPHA, PATH_GOAL = 3, 14, 0.55, 0.4
local BAR_HEIGHT, BAR_GAP = 4, 0.3
local BAR_BACK, BAR_PRODUCING, BAR_CONVERTING = 0x080d14, 0x59a6ff, 0xffcc4d
-- Цели выбранных стрелков (TARGET в selectionPass.ts) и патруль (ROUTE в cursorPass.ts): остановки — тайлы в рамке.
local TARGET, TARGET_ALPHA = 0xff594d, 0.7
local ROUTE, ROUTE_FILL, ROUTE_BORDER = 0xffd94d, 0.18, 0.85
-- Здания, которые обслуживают выбранные грузовики: только рамки (SERVE).
local SERVE = 0x73d9ff

local start: { x: number, y: number, wx: number, wy: number }? = nil
local last = { time = -1, entity = 0 }

-- Где сущность: середина и размер в тайлах; у юнита — описанный квадрат кольца.
local function bounds(c, e: number): (number, number, number, number, boolean)
	local at = c:get(e, "Position")
	local mover = c:get(e, "Mover")
	if mover then
		local size = (mover.radius + RING_MARGIN) * 2
		return at.x, at.y, size, size, true
	end
	local building = c:get(e, "Building")
	if building then
		return at.x, at.y, building.width, building.height, false
	end
	return at.x, at.y, 1, 1, true
end

-- Кольцо вокруг юнита или рамка в два пикселя вокруг здания.
local function mark(c, e: number, share: number)
	if not c:alive(e) or not c:get(e, "Position") then
		return
	end
	local x, y, w, h, round = bounds(c, e)
	local alpha = share * settings.prefs(c).selection
	if round then
		-- Кольцо — как спрайт 64 пикселя с ободом в 4: толщина растёт с размером.
		c.draw:circle(x, y, w / 2 - w * 3 / 64, SELECTED, w * c.camera.zoom * 4 / 64, alpha)
	else
		c.draw:rect(x - w / 2, y - h / 2, x + w / 2, y + h / 2, SELECTED, 2, alpha)
	end
end

-- Пунктир от (x1, y1) к (x2, y2): точки PATH_DOT пикселей через PATH_GAP пикселей экрана, от конца.
local function dashes(c, x1: number, y1: number, x2: number, y2: number, alpha: number, color: number?)
	local pixel = 1 / c.camera.zoom
	local dot, step = PATH_DOT * pixel, PATH_GAP * pixel
	local length = math.sqrt((x2 - x1) ^ 2 + (y2 - y1) ^ 2)
	local along = 0
	while along < length do
		local x = x2 + (x1 - x2) / length * along
		local y = y2 + (y1 - y2) / length * along
		c.draw:rect(x - dot / 2, y - dot / 2, x + dot / 2, y + dot / 2, color or SELECTED, nil, alpha)
		along += step
	end
end

-- Полоска хода над сущностью: value от 0 до 1.
local function bar(c, e: number, value: number, color: number)
	local pixel = 1 / c.camera.zoom
	local x, y, w, h = bounds(c, e)
	local height = BAR_HEIGHT * pixel
	local top = y - h / 2 - BAR_GAP - height
	local left = x - w / 2
	c.draw:rect(left - pixel, top - pixel, left + w + pixel, top + height + pixel, BAR_BACK)
	c.draw:rect(left, top, left + w * math.clamp(value, 0, 1), top + height, color)
end

-- Цели выбранных стрелков: пунктир от стрелка к тому, в кого он целится, — он сам или турели на нём; одна цель —
-- одна рамка, сколько бы ни целилось.
local function aims(c, selection)
	local chosen = {}
	for _, e in selection do
		chosen[e] = true
	end
	local targets: { [number]: { number } } = {}
	local function aim(shooter: number, target: number)
		if target < 0 or not chosen[shooter] or not c:alive(target) then
			return
		end
		local list = targets[shooter] or {}
		if not table.find(list, target) then
			table.insert(list, target)
		end
		targets[shooter] = list
	end
	for _, e in selection do
		local armed = c:get(e, "Armed")
		if armed then
			aim(e, armed.target)
		end
	end
	for _, e in c:each({ "Attached", "Armed" }) do
		aim(c:get(e, "Attached").parent, c:get(e, "Armed").target)
	end
	local marked = {}
	local half = PATH_GOAL
	for shooter, list in targets do
		local from = c:get(shooter, "Position")
		for _, target in list do
			local to = c:get(target, "Position")
			if from and to then
				dashes(c, from.x, from.y, to.x, to.y, TARGET_ALPHA, TARGET)
				if not marked[target] then
					marked[target] = true
					c.draw:rect(to.x - half, to.y - half, to.x + half, to.y + half, TARGET, 2)
				end
			end
		end
	end
end

-- Маршрут на карте (DrawnRoute в cursorPass.ts): остановки — прямоугольники (середина и размер) в рамке, между ними
-- пунктир; closed — замкнут по кругу, а не ещё набирается; only — только рамки, без пунктира (обслуживание).
local function route(c, stops, closed: boolean, color: number, only: boolean?)
	local border = 1 / 16
	for i, stop in stops do
		local x, y = stop.x - stop.width / 2, stop.y - stop.height / 2
		local right, bottom = x + stop.width, y + stop.height
		c.draw:rect(x, y, right, bottom, color, nil, ROUTE_FILL)
		c.draw:rect(x, y, right, y + border, color, nil, ROUTE_BORDER)
		c.draw:rect(x, bottom - border, right, bottom, color, nil, ROUTE_BORDER)
		c.draw:rect(x, y + border, x + border, bottom - border, color, nil, ROUTE_BORDER)
		c.draw:rect(right - border, y + border, right, bottom - border, color, nil, ROUTE_BORDER)
		local nextStop = stops[i + 1] or (if closed and #stops > 1 then stops[1] else nil)
		if nextStop and not only then
			dashes(c, nextStop.x, nextStop.y, stop.x, stop.y, PATH_ALPHA, color)
		end
	end
end

-- Остановка-здание: середина и размер; пропавшего нет.
local function stopOf(c, e: number)
	local at = c:alive(e) and c:get(e, "Position")
	local building = at and c:get(e, "Building")
	return if building then { x = at.x, y = at.y, width = building.width, height = building.height } else nil
end

-- Маршруты для показа (routesOf): набираемый игроком, отмечаемые и назначенные здания обслуживания, маршруты
-- выбранных грузовиков и патрули выбранных бойцов — каждый по разу.
local function routes(c, selection)
	local seen = {}
	local function add(entities: { number }, closed: boolean, color: number, only: boolean?)
		local key = (if only then "serve" else tostring(closed)) .. ":" .. table.concat(entities, ",")
		if #entities == 0 or seen[key] then
			return
		end
		seen[key] = true
		local stops = {}
		for _, e in entities do
			table.insert(stops, stopOf(c, e))
		end
		route(c, stops, closed, color, only)
	end
	local mode = c.shared.mode
	if mode and mode.kind == "routing" then
		add(mode.stops, false, ROUTE)
	elseif mode and mode.kind == "serving" then
		add(mode.buildings, false, SERVE, true)
	end
	for _, e in selection do
		local hauler = c:get(e, "Hauler")
		if hauler and #hauler.serve > 0 then
			add(hauler.serve, false, SERVE, true)
		end
	end
	for _, e in selection do
		local hauler = c:get(e, "Hauler")
		if hauler and #hauler.route > 0 then
			add(hauler.route, true, ROUTE)
		end
	end
	-- Патруль: точки — тайлы.
	for _, e in selection do
		local state = c:get(e, "Tactics")
		local points = state and state.patrol
		if not points or #points < 4 then
			continue
		end
		local key = "patrol:" .. table.concat(points, ",")
		if seen[key] then
			continue
		end
		seen[key] = true
		local stops = {}
		for i = 1, #points - 1, 2 do
			table.insert(stops, { x = points[i] + 0.5, y = points[i + 1] + 0.5, width = 1, height = 1 })
		end
		route(c, stops, true, ROUTE)
	end
end

-- Пути, флажки сбора и полоски выпуска у выбранного.
local function marks(c, selection)
	local pixel = 1 / c.camera.zoom
	routes(c, selection)
	aims(c, selection)
	for _, e in selection do
		-- Путь — под кольцом: точки отсчитываются от конца пути, поэтому стоят на земле, а не ползут с юнитом.
		local path = c:get(e, "Path")
		local at = c:get(e, "Position")
		if path and at and #path.points >= 2 then
			local points = { at.x, at.y }
			for _, value in path.points do
				table.insert(points, value)
			end
			local dot, step = PATH_DOT * pixel, PATH_GAP * pixel
			local carry = 0
			for i = #points - 1, 3, -2 do
				local dx, dy = points[i - 2] - points[i], points[i - 1] - points[i + 1]
				local length = math.sqrt(dx * dx + dy * dy)
				local along = carry
				while along < length do
					local x, y = points[i] + dx / length * along, points[i + 1] + dy / length * along
					c.draw:rect(x - dot / 2, y - dot / 2, x + dot / 2, y + dot / 2, SELECTED, nil, PATH_ALPHA)
					along += step
				end
				carry = along - length
			end
			local gx, gy, half = points[#points - 1], points[#points], PATH_GOAL / 2
			c.draw:rect(gx - half, gy - half, gx + half, gy + half, SELECTED, 2)
		end
		-- Круг раздачи выбранной машины снабжения: свои внутри него пополняют магазины с её склада.
		local kind = at and c:proto(e)
		local serves = kind and kind.data and kind.data.supplies
		if serves then
			local dot, step = PATH_DOT * pixel, PATH_GAP * pixel
			local count = math.ceil(math.pi * 2 * serves.radius / step)
			for i = 0, count - 1 do
				local angle = i / count * math.pi * 2
				local x, y = at.x + math.cos(angle) * serves.radius, at.y + math.sin(angle) * serves.radius
				c.draw:rect(x - dot / 2, y - dot / 2, x + dot / 2, y + dot / 2, SELECTED, nil, PATH_ALPHA)
			end
		end
		local producer = c:get(e, "Producer")
		if producer and producer.rally and at then
			-- Точка сбора — тайл: флажок в его середине.
			local x, y = producer.rallyX + 0.5, producer.rallyY + 0.5
			dashes(c, at.x, at.y, x, y, PATH_ALPHA)
			c.draw:rect(x - pixel, y - 0.9, x + pixel, y, SELECTED)
			c.draw:rect(x + pixel, y - 0.9, x + pixel + 0.45, y - 0.6, SELECTED)
		end
	end
	-- Полоски превращения над своими (BAR_CONVERTING).
	for _, e in c:each({ "Converting", "Owner" }) do
		if c:mine(e) then
			local converting = c:get(e, "Converting")
			bar(c, e, 1 - converting.left / converting.total, BAR_CONVERTING)
		end
	end
	-- Полоски выпуска над своими заводами; пока здание сворачивается, выпуск стоит.
	for _, e in c:each({ "Producer", "Owner" }) do
		local producer = c:get(e, "Producer")
		if c:mine(e) and producer.unit ~= "" and not c:has(e, "Converting") then
			local unit = c.protos.units[producer.unit]
			bar(c, e, producer.progress / (unit.data.buildTime or 1), BAR_PRODUCING)
		end
	end
end

function select.update(c)
	local input = c.input
	local shared = c.shared
	local selection = shared.selection or {}
	-- Погибшие выпадают сами.
	local alive = {}
	for _, e in selection do
		if c:alive(e) then
			table.insert(alive, e)
		end
	end
	selection = alive
	-- Под меню партии управление молчит; выделенное остаётся видно.
	if shared.paused then
		start = nil
		shared.selection = selection
		marks(c, selection)
		for _, e in selection do
			mark(c, e, 1)
		end
		return
	end

	-- В режиме наведения (выбор места MCV) щелчок по карте — его, а не выделение; в наборе патруля рамка — выделение.
	if input.pressed.left and input.inside and not input.over_ui and (not shared.mode or shared.mode.selects) then
		start = { x = input.x, y = input.y, wx = input.wx, wy = input.wy }
	end
	if start then
		local moved = math.abs(input.x - start.x) + math.abs(input.y - start.y) > select.data.threshold
		-- Рамку тянут: камера у края экрана едет за ней (cameras/rts).
		shared.boxing = input.down.left and moved
		if input.down.left and moved then
			c.draw:rect(start.wx, start.wy, input.wx, input.wy, SELECTED, nil, BOX_FILL_ALPHA)
			c.draw:rect(start.wx, start.wy, input.wx, input.wy, SELECTED, 1)
			-- Кого выберет рамка, если отпустить её сейчас, — бледнее выбранных.
			for _, e in c:within(start.wx, start.wy, input.wx, input.wy, { "Unit" }) do
				if c:mine(e) and not table.find(selection, e) then
					mark(c, e, HIT_ALPHA)
				end
			end
		end
		-- Долгое касание стало приказом (controls/orders.luau), щелчок — точкой патруля (controls/patrol): отпускание
		-- не выделяет.
		local swallowed = input.released.left and c.shared.swallow
		if swallowed then
			c.shared.swallow = nil
		end
		if input.released.left and not swallowed then
			local picked = {}
			if moved then
				for _, e in c:within(start.wx, start.wy, input.wx, input.wy, { "Unit" }) do
					if c:mine(e) then
						table.insert(picked, e)
					end
				end
			else
				local e = c:pick(input.wx, input.wy)
				if e and c:mine(e) then
					picked = { e }
					-- Двойной щелчок: все свои того же вида на экране.
					if last.entity == e and c.time - last.time < select.data.double then
						local kind = c:proto(e)
						local x1, y1 = c:to_world(0, 0)
						local x2, y2 = c:to_world(c.screen.w, c.screen.h)
						picked = {}
						for _, other in c:within(x1, y1, x2, y2) do
							if c:mine(other) and c:proto(other) == kind then
								table.insert(picked, other)
							end
						end
					end
					last = { time = c.time, entity = e }
				end
			end
			if input.keys.shift then
				for _, e in picked do
					if not table.find(selection, e) then
						table.insert(selection, e)
					end
				end
			else
				selection = picked
			end
			start = nil
		end
	end
	if not input.down.left then
		start = nil
	end
	-- Открыто окно исследований (ui/tech) — Escape закрывает его, и только.
	if input.hits.escape and shared.techOpen then
		shared.techOpen = false
		shared.modeClosedAt = c.time
	end
	-- Этот Escape уже снял режим (controls/deploy): выделение — следующим нажатием.
	if input.hits.escape and shared.modeClosedAt ~= c.time then
		-- Отменять нечего — Escape открывает меню партии (ui/pause), если тот же Escape его не закрыл.
		if #selection == 0 and shared.menuClosedAt ~= c.time then
			shared.paused = true
		end
		selection = {}
	end
	shared.selection = selection

	marks(c, selection)
	for _, e in selection do
		mark(c, e, 1)
	end
end

return select
