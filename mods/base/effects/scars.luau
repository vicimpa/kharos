--!strict
-- Следы боя на земле — перенос decalsPass.ts (scar, burn, wreck): от взрыва остаётся гарь, от пули — щербинки, от
-- луча — подпалина, от погибшей техники — остов. Сигналы шлёт система боя движка; на болоте гари не бывает.
-- Следы растворяются со временем и забываются вне обзора (c:stamp).

local scars = {}

scars.data = {
	-- Сколько секунд живут отметины и остовы (TRACE_LIFE).
	scarLife = 240,
	burnLife = 240,
	wreckLife = 600,
	-- Насколько плотны гарь и остовы: гарь просвечивает грунтом, остов непрозрачен.
	markOpacity = 0.7,
	-- Поперечник гари в тайлах на тайл размера взрыва; взрыв меньше pockSize — попадание пули.
	scorchScale = 1.5,
	pockSize = 0.3,
}

-- Номер следа: от него вариант картинки (trace.id % VARIANTS).
local count = 0

local function variant(): number
	count += 1
	return count % 3
end

local function onGround(c, x: number, y: number): boolean
	return c:terrain(x, y) ~= 0
end

-- Гарь поперечника index из sprites/scorch.
local function scorch(c, x: number, y: number, index: number, life: number)
	local kind = c.protos.sprites.scorch
	c:stamp({ kind = kind, phase = index * kind.data.variants + variant(), x = x, y = y, opacity = scars.data.markOpacity, life = life })
end

-- Вид юнита по номеру вида хоста: остов рисуется по нему.
local byId: { [number]: string }? = nil

local function unitName(c, id: number): string?
	if not byId then
		local map = {}
		for name, kind in c.protos.units do
			map[kind.id] = name
		end
		byId = map
	end
	return (byId :: { [number]: string })[id]
end

scars.signals = {
	-- Отметина от взрыва размера size: гарь, а от пули — щербинки.
	scar = function(c, trace)
		if not onGround(c, trace.x, trace.y) then
			return
		end
		local d = scars.data
		if trace.size < d.pockSize then
			c:stamp({ kind = c.protos.sprites.pock, phase = variant(), x = trace.x, y = trace.y, opacity = d.markOpacity, life = d.scarLife })
			return
		end
		local sizes = c.protos.sprites.scorch.data.sizes
		local pixels = trace.size * d.scorchScale * 16
		local index = 1
		for i = 2, #sizes do
			if math.abs(sizes[i] - pixels) < math.abs(sizes[index] - pixels) then
				index = i
			end
		end
		scorch(c, trace.x, trace.y, index - 1, d.scarLife)
	end,
	-- Подпалина от луча.
	burn = function(c, trace)
		if onGround(c, trace.x, trace.y) then
			scorch(c, trace.x, trace.y, 0, scars.data.burnLife)
		end
	end,
	-- Остов погибшей техники, повёрнутый, как она стояла.
	wreck = function(c, trace)
		local name = trace.proto and unitName(c, trace.proto)
		local kind = c.protos.sprites.wreck
		local phase = name and table.find(kind.data.names, name)
		if not phase then
			return
		end
		c:stamp({ kind = kind, phase = phase - 1, angle = trace.facing, x = trace.x, y = trace.y, opacity = 1, life = scars.data.wreckLife, layer = 2 })
	end,
}

return scars
