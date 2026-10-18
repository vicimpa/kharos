--!strict
-- Ворота. Плиты выезжают из земли; каждая занимает тайл, их тянут линией, как стену, и секции вплотную — одни ворота
-- любой ширины. Обычно плиты опущены (Footprint.passable): через них ходят и ездят все, выстрелы летят поверху. Когда к
-- воротам подходит чужой наземный юнит — не хозяин, не ничей и не союзник хозяина (ближе close тайлов до любой секции),
-- плиты поднимаются и становятся стеной — и для своих тоже. Опускаются, когда чужих не осталось ближе open: запас между
-- порогами не даёт им хлопать. Секция, на которой кто-то стоит, не поднимается, пока он не съедет: врага, который успел
-- въехать, она уже не остановит, а своего не подбросит; остальные секции тех же ворот поднимаются. Летающим ворота
-- безразличны. Недостроенные ворота — стройка: метку Gate здание получает готовым.

local kinds = require("lib/kinds")

local readf64 = buffer.readf64

local mechanic = {}

mechanic.data = {
	-- Ближе скольких тайлов чужой поднимает плиты и дальше скольких — опускает.
	close = 6,
	open = 7.5,
}

mechanic.components = {
	-- Готовые ворота: открыты ли — Footprint.passable.
	Gate = {},
}

-- Снаряжение вида: ворота поднимаются перед чужими.
function mechanic.equip(kind, entity)
	if kind.data.gate then
		entity.Gate = {}
	end
end

local function key(x: number, y: number): number
	return x * 65536 + y
end

mechanic.systems = {
	-- Ворота закрываются перед чужими и открываются за ними (gates).
	gates = {
		query = { "Gate", "Footprint", "Position", "Owner" },
		every = 4,
		run = function(q, ctx)
			if q.n == 0 then
				return
			end
			local data = mechanic.data
			local reach = data.open
			local list = {}
			-- Ворота разложены по клеткам со стороной в порог открытия: юнит смотрит только свою клетку и соседние.
			local cells: { [number]: { any } } = {}
			local byTile: { [number]: any } = {}
			for i = 0, q.n - 1 do
				local at = i * 8
				local entity = readf64(q.entity, at)
				if ctx:has(entity, "Site") then
					continue
				end
				local x, y = readf64(q.Position.x, at), readf64(q.Position.y, at)
				local gate = {
					entity = entity,
					player = readf64(q.Owner.player, at),
					x = x,
					y = y,
					open = readf64(q.Footprint.passable, at) ~= 0,
					foe = math.huge,
					held = false,
				}
				table.insert(list, gate)
				local cell = key(math.floor(x / reach), math.floor(y / reach))
				cells[cell] = cells[cell] or {}
				table.insert(cells[cell], gate)
				byTile[key(math.floor(x), math.floor(y))] = gate
			end
			-- Союзники каждого игрока.
			local friends: { [number]: { number } } = {}
			for _, e in ctx:each({ "Player" }) do
				local own = ctx:get(e, "Player")
				friends[own.id] = own.allies or {}
			end
			local units = ctx:query({ "Unit", "Owner", "Position", "Mover" })
			local air = ctx:id("air")
			for i = 0, units.n - 1 do
				local at = i * 8
				if readf64(units.Mover.class, at) == air then
					continue
				end
				local x, y = readf64(units.Position.x, at), readf64(units.Position.y, at)
				local player = readf64(units.Owner.player, at)
				local cx, cy = math.floor(x / reach), math.floor(y / reach)
				for dy = -1, 1 do
					for dx = -1, 1 do
						for _, gate in cells[key(cx + dx, cy + dy)] or {} do
							-- В проёме — тот, чей центр в тайле ворот.
							if math.abs(x - gate.x) < 0.5 and math.abs(y - gate.y) < 0.5 then
								gate.held = true
							end
							local distance = math.sqrt((x - gate.x) ^ 2 + (y - gate.y) ^ 2)
							if player ~= gate.player and player ~= 0 and distance < gate.foe and not table.find(friends[gate.player] or {}, player) then
								gate.foe = distance
							end
						end
					end
				end
			end
			-- Секции вплотную — одни ворота: чужой у одной поднимает все.
			local grouped = {}
			for _, first in list do
				if grouped[first] then
					continue
				end
				local group = { first }
				grouped[first] = true
				local index = 1
				while index <= #group do
					local gate = group[index]
					index += 1
					local tx, ty = math.floor(gate.x), math.floor(gate.y)
					for _, side in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do
						local next = byTile[key(tx + side[1], ty + side[2])]
						if next and next.player == gate.player and not grouped[next] then
							grouped[next] = true
							table.insert(group, next)
						end
					end
				end
				local foe = math.huge
				for _, gate in group do
					foe = math.min(foe, gate.foe)
				end
				local moved = nil
				for _, gate in group do
					if gate.open and foe < data.close and not gate.held then
						ctx:set(gate.entity, "Footprint", { passable = false })
						moved = moved or gate
					elseif not gate.open and foe >= data.open then
						ctx:set(gate.entity, "Footprint", { passable = true })
						moved = moved or gate
					end
				end
				-- Одни ворота — один звук: секции поднимаются разом.
				if moved then
					ctx:signal("gate", { x = moved.x, y = moved.y })
				end
			end
		end,
	},
}

mechanic.on = {
	-- Достроенные ворота встают опущенными: недостроенные — стройка и проезд закрывают.
	built = function(ctx, event)
		local kind = kinds.of(ctx, event.entity)
		if kind and kind.data.gate then
			ctx:set(event.entity, "Footprint", { passable = true })
		end
	end,
}

-- На клиенте: плиты поднялись или опустились — шипит гидравлика и лязгает створка.
mechanic.signals = {
	gate = function(c, signal)
		c:sound("gate", { x = signal.x, y = signal.y, volume = 0.45 })
	end,
}

return mechanic
