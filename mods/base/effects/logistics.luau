--!strict
-- Груз на экране: транспортный луч — бирюзовая полоса, по которой груз бежит цветными точками от того, кто отдаёт, к
-- тому, кто забирает; шахта работает, пока в неё прибывает добытое, переработка — пока убывает её руда; над запертым
-- своим грузовиком — значок «Не подъехать».

local goods = require("lib/goods")
local kinds = require("lib/kinds")
local rgb = require("lib/color").rgb

local logistics = {}

logistics.data = {
	-- Шаг и скорость бегущего груза в тайлах и тайлах в секунду; на сколько тайлов вглубь основания уходит луч.
	cargoStep = 0.3,
	cargoSpeed = 2.5,
	inset = 0.4,
	-- Сколько секунд после перемены склада здание ещё значится работающим.
	workHold = 0.6,
	-- Насколько значок запертого грузовика выше его середины и его сторона, в тайлах.
	trappedRise = 0.9,
	icon = 0.75,
	-- Размеры заданы в точках: точка — пиксель экрана при таком масштабе (как у боя).
	effectZoom = 32,
}

local TRACTOR = rgb(0.25, 0.95, 0.85)

-- Где на сущности конец луча, протянутого к точке (x, y): юнит — его место, здание — ближняя часть основания.
local function endOf(c, e: number, x: number, y: number): (number?, number?)
	local at = c:get(e, "Position")
	if not at then
		return nil, nil
	end
	local size = c:get(e, "Building")
	if not size or c:has(e, "Unit") then
		return at.x, at.y
	end
	local inset = logistics.data.inset
	local left, top = at.x - size.width / 2, at.y - size.height / 2
	local insetX, insetY = math.min(inset, size.width / 2), math.min(inset, size.height / 2)
	return math.clamp(x, left + insetX, left + size.width - insetX), math.clamp(y, top + insetY, top + size.height - insetY)
end

-- Что последний раз было на складе работающего здания и до какой секунды оно значится работающим.
local activity: { [number]: { value: number, untilTime: number } } = {}

function logistics.update(c)
	local d = logistics.data
	local zoom = c.camera.zoom
	local time = c.time
	local function sized(points: number): number
		return math.max(points * zoom / d.effectZoom, 1)
	end
	local function dot(layer, x: number, y: number, size: number, color: number, level: number)
		local half = sized(size) / zoom / 2
		layer:line(x - half, y, x + half, y, color, sized(size), level)
	end

	-- Транспортные лучи.
	for _, e in c:each({ "Beam", "Position" }) do
		local beam = c:get(e, "Beam")
		for _, link in beam.links do
			local own, other = c:get(e, "Position"), c:get(link.target, "Position")
			if not other then
				continue
			end
			local ax, ay = endOf(c, e, other.x, other.y)
			local bx, by = endOf(c, link.target, own.x, own.y)
			if not ax or not bx then
				continue
			end
			local fromX, fromY, toX, toY = ax :: number, ay :: number, bx :: number, by :: number
			if link.pulling then
				fromX, fromY, toX, toY = toX, toY, fromX, fromY
			end
			if not c:sees(fromX, fromY) and not c:sees(toX, toY) then
				continue
			end
			local shimmer = 0.75 + 0.25 * math.sin(time * 9 + e + link.target)
			c.glow:line(fromX, fromY, toX, toY, TRACTOR, sized(7), 0.18 * shimmer)
			c.glow:line(fromX, fromY, toX, toY, TRACTOR, sized(2), 0.55 * shimmer)
			dot(c.glow, fromX, fromY, 6, TRACTOR, 0.7)
			dot(c.glow, toX, toY, 6, TRACTOR, 0.7)
			local kind = c.protos.goods[link.resource]
			local cargo = if kind then kind.data.color else 0xffffff
			local length = math.sqrt((toX - fromX) ^ 2 + (toY - fromY) ^ 2)
			local count = math.floor(length / d.cargoStep)
			local shift = ((time * d.cargoSpeed) / d.cargoStep) % 1
			for i = 0, count - 1 do
				local share = ((i + shift) * d.cargoStep) / length
				-- У концов груз проявляется и тает.
				local level = math.min(1, share * 4, (1 - share) * 4)
				local x, y = fromX + (toX - fromX) * share, fromY + (toY - fromY) * share
				dot(c.draw, x, y, 3, cargo, level)
				dot(c.glow, x, y, 2, cargo, level * 0.6)
			end
			c:light((fromX + toX) / 2, (fromY + toY) / 2, 10, 4, 0.5)
		end
	end

	-- Работа шахты и переработки — по их складу, завода изделий — по ходу сборки: пока число меняется, здание работает.
	-- Чужой склад виден не хуже своего, но только в обзоре.
	local seen = {}
	for _, e in c:each({ "Building", "Inventory" }) do
		local kind = kinds.of(c, e)
		local data = kind and kind.data
		local assembly = c:get(e, "Assembly")
		if not data or c:has(e, "Site") or not (data.extract or data.refines or assembly) then
			continue
		end
		seen[e] = true
		local stock = c:get(e, "Inventory")
		local value = if data.extract then goods.load(stock) elseif data.refines then goods.amount(stock, data.refines) else assembly.progress
		local state = activity[e]
		if not state then
			state = { value = value, untilTime = 0 }
			activity[e] = state
		end
		if math.abs(value - state.value) > 1e-9 then
			state.untilTime = time + d.workHold
		end
		state.value = value
		if time < state.untilTime then
			c:dress(e, { working = true })
		end
	end
	for e in activity do
		if not seen[e] then
			activity[e] = nil
		end
	end

	-- Запертые свои грузовики: им не выехать, пока не разберут то, чем их обстроили. Значок мигает.
	if (time % 1) < 0.7 then
		local alarm = c.protos.sprites.alarm
		for _, e in c:each({ "Hauler", "Position", "Owner" }) do
			if c:mine(e) and c:get(e, "Hauler").trapped then
				local at = c:get(e, "Position")
				c.draw:sprite(alarm, alarm.data.blocked, at.x, at.y - d.trappedRise, d.icon)
			end
		end
	end
end

return logistics
