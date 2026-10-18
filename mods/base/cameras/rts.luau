--!strict
-- Камера стратегии: клавиши и края экрана двигают, средняя кнопка тянет, колесо меняет масштаб вокруг курсора.
-- Масштабы — кратные пикселю спрайта, чтобы пиксель-арт не плыл.

local rts = {}

rts.data = {
	-- Логических пикселей на тайл: 16 — пиксель спрайта в пиксель экрана.
	zooms = { 8, 16, 24, 32, 48, 64 },
	start = 4,
	-- Скорость клавиш и краёв — экранов в секунду.
	pan = 0.9,
	-- Ширина края экрана, где мышь двигает камеру, в пикселях.
	edge = 6,
}

local level = rts.data.start
local drag: { x: number, y: number }? = nil

function rts.start(cam, c)
	cam.zoom = rts.data.zooms[level]
	-- Камера — к своей базе: первое своё здание.
	for _, e in c:each({ "Building", "Owner" }) do
		if c:mine(e) then
			local at = c:get(e, "Position")
			cam.x, cam.y = at.x, at.y + 3
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
	-- Клавиши и края.
	local dx, dy = 0, 0
	local keys = input.keys
	if keys.a or keys.left then dx -= 1 end
	if keys.d or keys.right then dx += 1 end
	if keys.w or keys.up then dy -= 1 end
	if keys.s or keys.down then dy += 1 end
	if input.inside and input.focused and not drag then
		local edge = rts.data.edge
		if input.x < edge then dx -= 1 end
		if input.x > screen.w - edge then dx += 1 end
		if input.y < edge then dy -= 1 end
		if input.y > screen.h - edge then dy += 1 end
	end
	local speed = rts.data.pan * math.max(screen.w, screen.h) / cam.zoom * dt
	cam.x += dx * speed
	cam.y += dy * speed
	-- Колесо: масштаб вокруг точки под курсором.
	if input.wheel ~= 0 and input.inside and not input.over_ui then
		local before = cam.zoom
		level = math.clamp(level + (if input.wheel > 0 then 1 else -1), 1, #rts.data.zooms)
		cam.zoom = rts.data.zooms[level]
		if cam.zoom ~= before then
			local px, py = input.x - screen.w / 2, input.y - screen.h / 2
			cam.x += px / before - px / cam.zoom
			cam.y += py / before - py / cam.zoom
		end
	end
	-- Не дальше края поля.
	local size = (c.game.data and c.game.data.size or 64) + 8
	cam.x = math.clamp(cam.x, -size, size)
	cam.y = math.clamp(cam.y, -size, size)
end

return rts
