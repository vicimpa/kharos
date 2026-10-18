--!strict
-- Камера стратегии: клавиши двигают, средняя кнопка тянет, колесо меняет масштаб вокруг курсора — как
-- в TS (controls.ts, cameraMotion.ts): колесо задаёт масштаб, который камера плавно догоняет, держа на месте точку
-- под курсором.

local rts = {}

rts.data = {
	-- Логических пикселей на тайл: 16 — пиксель спрайта в пиксель экрана. Пределы масштаба и начальный.
	minZoom = 4,
	maxZoom = 96,
	start = 32,
	-- Во сколько раз меняет масштаб пиксель прокрутки: exp(−пиксели × wheel); щелчок колеса — 40 пикселей.
	wheel = 0.0015,
	wheelLine = 40,
	-- Масштаб догоняет колесо: за столько секунд он проходит две трети пути; ближе этого (в логарифме) — встаёт.
	zoomSmoothing = 0.09,
	zoomArrived = 0.001,
	-- Скорость клавиш — экранов в секунду.
	pan = 0.9,
}

-- Масштаб, к которому идёт камера (nil — не меняется), и точка экрана, которая стоит на месте.
local target: number? = nil
local anchor = { x = 0, y = 0 }
local drag: { x: number, y: number }? = nil

function rts.start(cam, c)
	cam.zoom = rts.data.start
	target = nil
	-- Камера — к своим: первый свой юнит, MCV стартового набора (game.ts).
	for _, e in c:each({ "Unit", "Owner" }) do
		if c:mine(e) then
			local at = c:get(e, "Position")
			cam.x, cam.y = at.x, at.y
			break
		end
	end
end

function rts.update(cam, c)
	local input = c.input
	-- Под меню партии камера стоит.
	if c.shared.paused then
		drag = nil
		return
	end
	local screen = c.screen
	local dt = c.dt
	-- Тянуть средней кнопкой.
	if input.pressed.middle and input.inside then
		drag = { x = input.x, y = input.y }
	end
	if not input.down.middle then
		drag = nil
	end
	if drag then
		cam.x -= (input.x - drag.x) / cam.zoom
		cam.y -= (input.y - drag.y) / cam.zoom
		drag.x, drag.y = input.x, input.y
	end
	-- Клавиши.
	local dx, dy = 0, 0
	local keys = input.keys
	if keys.a or keys.left then dx -= 1 end
	if keys.d or keys.right then dx += 1 end
	if keys.w or keys.up then dy -= 1 end
	if keys.s or keys.down then dy += 1 end
	local speed = rts.data.pan * math.max(screen.w, screen.h) / cam.zoom * dt
	cam.x += dx * speed
	cam.y += dy * speed
	-- Колесо: масштаб в exp(…) раз от того, к которому камера уже идёт; вверх — ближе.
	local d = rts.data
	if input.wheel ~= 0 and input.inside and not input.over_ui then
		target = math.clamp((target or cam.zoom) * math.exp(input.wheel * d.wheelLine * d.wheel), d.minZoom, d.maxZoom)
		anchor.x, anchor.y = input.x, input.y
	end
	-- Камера догоняет масштаб; точка под курсором остаётся на месте.
	if target and dt > 0 then
		local goal = target :: number
		local next = cam.zoom * (goal / cam.zoom) ^ (1 - math.exp(-dt / d.zoomSmoothing))
		local arrived = math.abs(math.log(goal / next)) < d.zoomArrived
		local zoom = if arrived then goal else next
		local px, py = anchor.x - screen.w / 2, anchor.y - screen.h / 2
		cam.x += px / cam.zoom - px / zoom
		cam.y += py / cam.zoom - py / zoom
		cam.zoom = zoom
		if arrived then
			target = nil
		end
	end
	-- Не дальше края поля.
	local size = (c.game.data and c.game.data.size or 64) + 8
	cam.x = math.clamp(cam.x, -size, size)
	cam.y = math.clamp(cam.y, -size, size)
end

return rts
