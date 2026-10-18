--!strict
-- Стройка на экране: площадка рисуется чертежом, поверх которого снизу вверх растёт настоящее здание (у разбираемого —
-- уходит сверху вниз); от работающего ремонтника к работе тянется мерцающий луч сварки — зелёный, у разбора красный, —
-- с искрами и светом в темноте.

local noise = require("lib/noise").of
local earthworks = require("lib/earthworks")
local rgb = require("lib/color").rgb

local construction = {}

construction.data = {
	-- Искр на вспышку, как далеко они разлетаются в тайлах и сколько вспышек в секунду.
	sparks = 4,
	spread = 0.35,
	rate = 12,
	-- На сколько тайлов вглубь основания приходится конец луча.
	inset = 0.4,
	-- Размеры заданы в точках: точка — пиксель экрана при таком масштабе (как у боя).
	effectZoom = 32,
}

local MEND = rgb(0.3, 1, 0.55)
local WRECK = rgb(1, 0.22, 0.1)
-- Землеройные работы: срыть гору — алым, сгладить обрыв — землёй.
local BLAST = rgb(1, 0.12, 0.08)
local GRADE = rgb(0.55, 0.3, 0.1)
local CORE = rgb(1, 1, 1)

-- Конец луча на работе: у юнита — его центр, у здания — ближняя к ремонтнику точка основания.
local function endOf(c, target: number, x: number, y: number): (number?, number?)
	local at = c:get(target, "Position")
	if not at then
		return nil, nil
	end
	-- Землеройная работа — ближняя точка её тайлов.
	if c:has(target, "Dig") then
		local area = earthworks.area(c, target)
		if not area then
			return nil, nil
		end
		return math.clamp(x, area.x, area.x + area.width), math.clamp(y, area.y, area.y + area.height)
	end
	local size = c:get(target, "Building")
	if not size or c:has(target, "Unit") then
		return at.x, at.y
	end
	local inset = construction.data.inset
	local left, top = at.x - size.width / 2, at.y - size.height / 2
	local insetX, insetY = math.min(inset, size.width / 2), math.min(inset, size.height / 2)
	return math.clamp(x, left + insetX, left + size.width - insetX), math.clamp(y, top + insetY, top + size.height - insetY)
end

function construction.update(c)
	local d = construction.data
	-- Готовность площадок и разбираемых зданий.
	for _, e in c:each({ "Site", "Position" }) do
		local site = c:get(e, "Site")
		c:dress(e, { built = math.clamp(site.progress / site.total, 0, 1) })
	end

	local zoom = c.camera.zoom
	local function sized(points: number): number
		return math.max(points * zoom / d.effectZoom, 1)
	end
	local function line(fromX: number, fromY: number, toX: number, toY: number, thickness: number, color: number, level: number)
		c.glow:line(fromX, fromY, toX, toY, color, sized(thickness), level)
	end
	local function dot(x: number, y: number, size: number, color: number, level: number)
		local half = sized(size) / zoom / 2
		c.glow:line(x - half, y, x + half, y, color, sized(size), level)
	end
	local time = c.time
	for _, e in c:each({ "Repair", "Position" }) do
		local repair = c:get(e, "Repair")
		local target = repair.target
		if not repair.working or target < 0 or not c:alive(target) then
			continue
		end
		local from = c:get(e, "Position")
		local toX, toY = endOf(c, target, from.x, from.y)
		if not toX or not toY then
			continue
		end
		local fromX, fromY = from.x, from.y
		if not c:sees(fromX, fromY) and not c:sees(toX, toY) then
			continue
		end
		-- Луч начинается у края юнита.
		local mover = c:get(e, "Mover")
		local length = math.sqrt((toX - fromX) ^ 2 + (toY - fromY) ^ 2)
		if mover and length > 0 then
			local reach = math.min(mover.radius, length) / length
			fromX += (toX - fromX) * reach
			fromY += (toY - fromY) * reach
		end
		local site = c:get(target, "Site")
		local dig = c:get(target, "Dig")
		local color = if site and site.demolish then WRECK elseif dig and dig.kind == "peak" then BLAST elseif dig then GRADE else MEND
		local seed = e * 31 + target
		local flicker = 0.55 + 0.45 * noise(seed, math.floor(time * d.rate * 2))
		-- Свет сварки мерцает.
		c:light(toX, toY, 12, 5, 0.5 + 0.5 * noise(e + target, math.floor(time * d.rate * 2)))
		line(fromX, fromY, toX, toY, 4, color, 0.35 * flicker)
		line(fromX, fromY, toX, toY, 1.5, color, flicker)
		dot(fromX, fromY, 4, color, 0.8)
		dot(toX, toY, 7, color, flicker)
		dot(toX, toY, 3, CORE, flicker)
		-- Искры разлетаются от места работы и гаснут; каждая вспышка — в новые стороны, и искра падает.
		local beat = time * d.rate
		local phase = beat - math.floor(beat)
		for i = 0, d.sparks - 1 do
			local angle = noise(seed + i * 7, math.floor(beat)) * math.pi * 2
			local reach = d.spread * (0.4 + 0.6 * noise(seed + i * 13, math.floor(beat))) * phase
			dot(toX + math.cos(angle) * reach, toY + math.sin(angle) * reach + reach * phase * 0.6, 2, if i % 2 == 1 then CORE else color, 1 - phase)
		end
	end
end

return construction
