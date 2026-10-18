--!strict
-- Наводка ядерного удара: кнопка «Пуск» включает режим c.shared.mode, щелчок по карте — пуск в эту точку, и режим
-- кончается; правая кнопка и Esc — отмена, рамка — обычное выделение. Шахту сняли с выбора или в ней нет боеголовки —
-- режим кончается сам. Под указателем — круги взрыва и его ядра. И круги перехватчиков: выбранных и, пока ставится
-- новый, всех своих — видно, где защиты ещё нет.

local aim = {}

aim.data = {
	-- Сдвиг указателя, после которого щелчок становится рамкой, в пикселях.
	threshold = 6,
	-- Сторона точки пунктира в пикселях, шаг пунктира кругов взрыва в пикселях и круга перехватчика в тайлах.
	dot = 3,
	gap = 14,
	guardStep = 1.5,
}

local FORBIDDEN = 0xff4d40
local GUARD = 0x8cffd9
local BORDER_ALPHA, FILL_ALPHA = 0.85, 0.18

local pressed: { x: number, y: number }? = nil

-- Пунктирный круг: точки через step тайлов.
local function dotted(c, x: number, y: number, radius: number, step: number, color: number)
	local size = aim.data.dot / c.camera.zoom
	local count = math.ceil(math.pi * 2 * radius / step)
	for i = 0, count - 1 do
		local a = i / count * math.pi * 2
		local px, py = x + math.cos(a) * radius, y + math.sin(a) * radius
		c.draw:rect(px - size / 2, py - size / 2, px + size / 2, py + size / 2, color, nil, BORDER_ALPHA)
	end
end

-- Круги перехватчиков: выбранных и, пока ставится новый, всех своих и его под указателем.
local function guards(c)
	local mode = c.shared.mode
	local placing = mode and mode.kind == "placing" and c.protos.buildings[mode.building]
	local spec = placing and placing.data.intercept
	if spec then
		local x = math.floor(c.input.wx) - math.floor(placing.data.width / 2) + placing.data.width / 2
		local y = math.floor(c.input.wy) - math.floor(placing.data.height / 2) + placing.data.height / 2
		dotted(c, x, y, spec.radius, aim.data.guardStep, GUARD)
	end
	local selected = {}
	for _, e in c.shared.selection or {} do
		selected[e] = true
	end
	for _, e in c:each({ "Interceptor", "Position" }) do
		local kind = c:proto(e)
		local guard = kind and kind.data.intercept
		if guard and (selected[e] or (spec and c:mine(e))) then
			local at = c:get(e, "Position")
			dotted(c, at.x, at.y, guard.radius, aim.data.guardStep, GUARD)
		end
	end
end

function aim.update(c)
	guards(c)
	local shared, input = c.shared, c.input
	local mode = shared.mode
	if shared.paused or not mode or mode.kind ~= "aiming" then
		pressed = nil
		return
	end
	local silo = mode.silo
	local state = c:alive(silo) and c:get(silo, "Silo")
	if not state or not state.ready or not table.find(shared.selection or {}, silo) then
		shared.mode = nil
		return
	end
	if input.hits.escape or (input.pressed.right and input.inside and not input.over_ui) then
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	-- Под указателем — круги взрыва и тайл удара.
	if input.inside and not input.over_ui then
		local blast = c:proto(silo).data.warhead.blast
		local cx, cy = math.floor(input.wx) + 0.5, math.floor(input.wy) + 0.5
		local gap = aim.data.gap / c.camera.zoom
		dotted(c, cx, cy, blast.radius, gap, FORBIDDEN)
		dotted(c, cx, cy, blast.core, gap, FORBIDDEN)
		c.draw:rect(cx - 0.5, cy - 0.5, cx + 0.5, cy + 0.5, FORBIDDEN, nil, FILL_ALPHA)
		c.draw:rect(cx - 0.5, cy - 0.5, cx + 0.5, cy + 0.5, FORBIDDEN, 1, BORDER_ALPHA)
	end
	if input.pressed.left and input.inside and not input.over_ui then
		pressed = { x = input.x, y = input.y }
	end
	local start = pressed
	if start and input.released.left then
		pressed = nil
		-- Рамка — выделение: его сделает controls/select.
		if math.abs(input.x - start.x) + math.abs(input.y - start.y) > aim.data.threshold then
			shared.mode = nil
			return
		end
		c:send("launch", { silo = silo, x = math.floor(input.wx), y = math.floor(input.wy) })
		c:sound("order", { volume = 0.35 })
		shared.swallow = true
		shared.mode = nil
	end
end

-- Полоса режима (ui/hud): название и что делать.
aim.modes = {
	aiming = {
		describe = function(c)
			return c:t("mode.aiming"), c:t("mode.tips.aiming")
		end,
	},
}

return aim
