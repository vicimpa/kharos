--!strict
-- Камера стратегии: клавиши задают скорость, к которой камера разгоняется, а отпущенные — она плавно тормозит; средняя
-- и правая кнопки тянут камеру точно за мышью, а брошенная катится дальше (приказ правой — на отпускании без сдвига,
-- controls/orders); пока тянут рамку выделения, указатель у края видимой части карты двигает камеру, как клавиши;
-- колесо задаёт масштаб, который камера плавно догоняет, держа на месте точку под курсором; c.shared.flyTo — полёт к
-- точке без перелёта. Переставили камеру со стороны (мини-карта) — движение гаснет.

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
	-- Скорость клавиш — пикселей экрана в секунду, с Shift — втрое.
	keySpeed = 900,
	keyBoost = 3,
	-- Разгон от клавиш и торможение: за столько секунд скорость проходит две трети пути; медленнее rest пикселей в
	-- секунду камера уже стоит.
	acceleration = 0.15,
	deceleration = 0.25,
	rest = 4,
	-- Скорость мыши сглаживается за столько секунд; стояла дольше fling перед тем, как отпустили, — камеру остановили,
	-- а не бросили.
	dragSmoothing = 0.05,
	fling = 0.08,
	-- Полёт: пружина без перелёта, почти на месте через 5 / flight секунд; ближе arrived пикселей — прилетела.
	flight = 6,
	flightArrived = 0.5,
	-- Сколько пикселей от края видимой части карты двигают камеру, пока тянут рамку.
	edge = 6,
	-- Тряска от взрывов: сдвиг при полной силе на зуме shakeZoom, в тайлах; сколько силы уходит за секунду; как быстро
	-- камера дёргается.
	shakeOffset = 0.25,
	shakeZoom = 32,
	shakeDecay = 2.8,
	shakeFrequency = 40,
}

-- Масштаб, к которому идёт камера (nil — не меняется), и точка экрана, которая стоит на месте.
local target: number? = nil
local anchor = { x = 0, y = 0 }
local drag: { x: number, y: number, button: string }? = nil
-- Скорость камеры, пикселей экрана в секунду; сдвиг мыши за кадр, её сглаженная скорость и сколько секунд назад
-- она двигалась.
local velocityX, velocityY = 0, 0
local draggedX, draggedY, dragVelocityX, dragVelocityY, sinceDrag = 0, 0, 0, 0, math.huge
-- Куда камера летит сама (nil — не летит) и её скорость в полёте, тайлов в секунду.
local flight: { x: number, y: number }? = nil
local flightVelocityX, flightVelocityY = 0, 0
-- Где камера стояла после прошлого кадра: стоит в другом месте — её переставили со стороны.
local placed: { x: number, y: number }? = nil
-- Тряска: сдвиг, которым увели камеру в прошлом кадре (его снимают перед движением), и часы тряски.
local shaken = { x = 0, y = 0 }
local shakeTime = 0

-- Гасит всё движение.
local function halt()
	velocityX, velocityY, flight = 0, 0, nil
	flightVelocityX, flightVelocityY = 0, 0
end

-- Встала ли камера к своим: по сети мир приходит после старта, и встать к ним она может только с первым кадром.
local aimed = false

-- Камера к своим: заданная редактором (Player.camera) главнее, иначе — первый свой юнит, MCV стартового набора.
-- Встала — true.
local function aim(cam, c): boolean
	for _, e in c:each({ "Player" }) do
		local state = c:get(e, "Player")
		if state.id == c.player and type(state.camera) == "table" and #state.camera == 3 then
			cam.x, cam.y, cam.zoom = state.camera[1], state.camera[2], state.camera[3]
			return true
		end
	end
	for _, e in c:each({ "Unit", "Owner" }) do
		if c:mine(e) then
			local at = c:get(e, "Position")
			cam.x, cam.y = at.x, at.y
			return true
		end
	end
	return false
end

function rts.start(cam, c)
	cam.zoom = rts.data.start
	target, drag, placed = nil, nil, nil
	halt()
	aimed = aim(cam, c)
end

function rts.update(cam, c)
	local input = c.input
	if not aimed then
		aimed = aim(cam, c)
	end
	-- Прошлый сдвиг тряски снимается: камера движется от своего места, а не от уведённого.
	cam.x -= shaken.x
	cam.y -= shaken.y
	shaken.x, shaken.y = 0, 0
	-- Под меню партии камера стоит.
	if c.shared.paused then
		drag = nil
		halt()
		return
	end
	local screen = c.screen
	local dt = c.dt
	local d = rts.data
	if placed and (cam.x ~= placed.x or cam.y ~= placed.y) then
		halt()
	end
	if c.shared.flyTo then
		if not flight then
			flightVelocityX, flightVelocityY = 0, 0
		end
		flight = { x = c.shared.flyTo.x, y = c.shared.flyTo.y }
		velocityX, velocityY = 0, 0
		c.shared.flyTo = nil
	end
	-- Тянуть средней или правой кнопкой: камера идёт за мышью сразу, без разгона. Над панелью правую не берут.
	if input.pressed.middle and input.inside then
		drag = { x = input.x, y = input.y, button = "middle" }
	elseif input.pressed.right and input.inside and not input.over_ui and not input.touch then
		drag = { x = input.x, y = input.y, button = "right" }
	end
	if drag then
		local dx, dy = input.x - drag.x, input.y - drag.y
		if dx ~= 0 or dy ~= 0 then
			cam.x -= dx / cam.zoom
			cam.y -= dy / cam.zoom
			draggedX += dx
			draggedY += dy
			sinceDrag = 0
			halt()
		end
		drag.x, drag.y = input.x, input.y
	end
	if dt <= 0 then
		return
	end
	-- Скорость мыши — за кадр, сглаженная: по ней камеру бросают.
	local smooth = 1 - math.exp(-dt / d.dragSmoothing)
	dragVelocityX += (draggedX / dt - dragVelocityX) * smooth
	dragVelocityY += (draggedY / dt - dragVelocityY) * smooth
	draggedX, draggedY = 0, 0
	sinceDrag += dt
	-- Отпустили: если ещё тянули в последний миг, камера катится дальше с той же скоростью.
	if drag and not input.down[drag.button] then
		drag = nil
		if sinceDrag <= d.fling then
			velocityX, velocityY = -dragVelocityX, -dragVelocityY
		end
		dragVelocityX, dragVelocityY = 0, 0
	end
	-- Клавиши задают скорость, к которой камера разгоняется; без них она тормозит. Клавиши прерывают полёт.
	local keys = input.keys
	-- Указатель у края видимой части карты двигает камеру только пока тянут рамку: она растёт за край. Края — у
	-- видимой части: верхняя полоса и нижняя панель закрывают свои (c.shared.inset от ui/hud).
	local edgeX, edgeY = 0, 0
	if c.shared.boxing and input.inside then
		local inset = c.shared.inset or { top = 0, bottom = 0, left = 0, right = 0 }
		edgeX = (if input.x >= screen.w - (inset.right or 0) - d.edge then 1 else 0) - (if input.x <= (inset.left or 0) + d.edge then 1 else 0)
		edgeY = (if input.y >= screen.h - (inset.bottom or 0) - d.edge then 1 else 0) - (if input.y <= (inset.top or 0) + d.edge then 1 else 0)
	end
	local right = math.sign((if keys.d or keys.right then 1 else 0) - (if keys.a or keys.left then 1 else 0) + edgeX)
	local down = math.sign((if keys.s or keys.down then 1 else 0) - (if keys.w or keys.up then 1 else 0) + edgeY)
	local speed = d.keySpeed * (if keys.shift then d.keyBoost else 1)
	local thrust = right ~= 0 or down ~= 0
	if thrust then
		flight = nil
	end
	local blend = 1 - math.exp(-dt / (if thrust then d.acceleration else d.deceleration))
	velocityX += (right * speed - velocityX) * blend
	velocityY += (down * speed - velocityY) * blend
	if not thrust and math.sqrt(velocityX * velocityX + velocityY * velocityY) < d.rest then
		velocityX, velocityY = 0, 0
	end
	cam.x += velocityX * dt / cam.zoom
	cam.y += velocityY * dt / cam.zoom
	-- Полёт: пружина без перелёта, решённая точно — шаг устойчив при любой длине кадра.
	if flight then
		local goal = flight :: { x: number, y: number }
		local fade = math.exp(-d.flight * dt)
		local pullX = flightVelocityX + d.flight * (cam.x - goal.x)
		local pullY = flightVelocityY + d.flight * (cam.y - goal.y)
		local offsetX = (cam.x - goal.x + pullX * dt) * fade
		local offsetY = (cam.y - goal.y + pullY * dt) * fade
		flightVelocityX = (flightVelocityX - d.flight * pullX * dt) * fade
		flightVelocityY = (flightVelocityY - d.flight * pullY * dt) * fade
		local arrived = math.sqrt(offsetX * offsetX + offsetY * offsetY) * cam.zoom < d.flightArrived
			and math.sqrt(flightVelocityX * flightVelocityX + flightVelocityY * flightVelocityY) * cam.zoom < d.flightArrived * d.flight
		cam.x, cam.y = goal.x + (if arrived then 0 else offsetX), goal.y + (if arrived then 0 else offsetY)
		if arrived then
			halt()
		end
	end
	-- Колесо: масштаб в exp(…) раз от того, к которому камера уже идёт; вверх — ближе.
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
		-- В полёте масштаб меняется вокруг середины экрана: туда камера и летит.
		local px, py = if flight then 0 else anchor.x - screen.w / 2, if flight then 0 else anchor.y - screen.h / 2
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
	placed = { x = cam.x, y = cam.y }
	-- Тряска: сила копится от толчков (c.shared.trauma, audio/battle) и уходит; камеру уводит на квадрат силы, плавно —
	-- по сумме синусов. На экране она растёт с зумом.
	local trauma = math.max(0, (c.shared.trauma or 0) - dt * d.shakeDecay)
	c.shared.trauma = trauma
	shakeTime += dt
	if trauma > 0 then
		local function wave(seed: number): number
			local f = shakeTime * d.shakeFrequency
			return (math.sin(f + seed) + math.sin(f * 1.73 + seed * 2.1) * 0.6 + math.sin(f * 2.9 + seed * 3.7) * 0.3) / 1.9
		end
		local strength = trauma * trauma * d.shakeOffset * (cam.zoom / d.shakeZoom)
		shaken.x, shaken.y = wave(0) * strength, wave(17) * strength
		cam.x += shaken.x
		cam.y += shaken.y
	end
end

return rts
