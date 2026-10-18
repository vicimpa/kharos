--!strict
-- Камера витрины — перенос direct из packages/client/src/game/game.ts: плавно идёт к середине всех юнитов и зданий,
-- медленно кружа вокруг неё, — так в кадре бой или работающая база, даже когда всё стоит. Слева на широком экране —
-- меню: действие держится правее него.

local showcase = {}

showcase.data = {
	zoom = 28,
	follow = 0.4,
	-- Оборотов вокруг середины в секунду и радиус круга, в тайлах.
	orbit = 0.05,
	radius = 6,
	-- С какой ширины экрана меню слева занимает место и сколько его.
	wide = 760,
	menu = 400,
}

local orbit = 0
local centered = false
local lastTick = -1
local focus = { x = 0, y = 0 }

function showcase.start(cam, c)
	orbit = c.hash(c.time, 1, 17) * math.pi * 2
	cam.zoom = showcase.data.zoom
end

function showcase.update(cam, c)
	local d = showcase.data
	-- Мир начали заново — первый кадр сразу на месте.
	if c.tick < lastTick then
		centered = false
	end
	lastTick = c.tick
	local x, y, count = 0, 0, 0
	-- Здания — тоже действие: у стройки и обороны оно вокруг них.
	for _, component in { "Unit", "Building" } do
		for _, e in c:each({ "Position", component }) do
			local at = c:get(e, "Position")
			x += at.x
			y += at.y
			count += 1
		end
	end
	if count == 0 then
		return
	end
	local width = c.screen.w
	local inset = if width >= d.wide then math.min(width * 0.4, d.menu) else 0
	orbit += c.dt * d.orbit * math.pi * 2
	local tx = x / count + math.cos(orbit) * d.radius
	local ty = y / count + math.sin(orbit) * d.radius
	-- Первый кадр — сразу на месте, дальше — вдогонку.
	local follow = if centered then 1 - math.exp(-c.dt * d.follow) else 1
	centered = true
	focus.x += (tx - focus.x) * follow
	focus.y += (ty - focus.y) * follow
	cam.zoom = d.zoom
	-- Середина видимой части правее меню.
	cam.x = focus.x - inset / 2 / cam.zoom
	cam.y = focus.y
end

return showcase
