--!strict
-- Патруль и возвращение на место. Стойку, погоню и то, что юнит уходит в погоню с места (Tactics.away, homeX, homeY),
-- ведёт бой движка; здесь — что после: вставший без цели продолжает обход или возвращается, откуда ушёл, а агрессивный
-- в походе — идёт, куда шёл.

local tactics = require("lib/tactics")
local queue = require("lib/queue")
local world = require("lib/world")

local mechanic = {}

-- Кусок панели игрока (ui/hud).
mechanic.panel = require("./panel")

mechanic.data = {
	-- Раз во сколько тиков вставший юнит вспоминает о патруле и о месте, куда вернуться.
	resumeTicks = 10,
	-- Ближе скольких тайлов к своему месту юнит считается пришедшим: само место мог занять сосед.
	homeReach = 1.5,
}

local function isTile(value: any): boolean
	return type(value) == "number" and value == math.floor(value)
end

-- Свои живые бойцы из списка, без повторов: им раздаётся патруль. Безоружные носители турелей — тоже.
local function fightersOf(ctx, player: number, units: any): { number }
	local list, seen = {}, {}
	if type(units) ~= "table" then
		return list
	end
	local turrets = tactics.mounts(ctx)
	for _, e in units do
		if type(e) == "number" and not seen[e] and ctx:alive(e) and ctx:has(e, "Unit") then
			seen[e] = true
			local owner = ctx:get(e, "Owner")
			if owner and owner.player == player and tactics.canFight(ctx, e, turrets[e]) then
				table.insert(list, e)
			end
		end
	end
	return list
end

-- Занят ли юнит боем: у него или у его турелей есть цель (fighting).
local function fighting(ctx, entity: number, turrets: { number }?): boolean
	local armed = ctx:get(entity, "Armed")
	if armed and armed.target >= 0 then
		return true
	end
	for _, turret in turrets or {} do
		local own = ctx:get(turret, "Armed")
		if own and own.target >= 0 then
			return true
		end
	end
	return false
end

mechanic.commands = {
	-- { units, points = { x, y, … }, append } — патруль: каждый ходит по кругу от тайла, где стоит, через точки и
	-- обратно, по пути бьёт врагов по своей стойке, а после боя продолжает обход. append — точки добавляются к идущему
	-- патрулю; кто не патрулировал, начинает патруль от своего места.
	patrol = function(ctx, player, args)
		if type(args.points) ~= "table" then
			return
		end
		local limit = tactics.patrolLimit
		local stops = {}
		local points = args.points
		for i = 1, #points - 1, 2 do
			if #stops >= limit * 2 then
				break
			end
			local x, y = points[i], points[i + 1]
			if isTile(x) and isTile(y) and world.inBounds(ctx, x, y) then
				table.insert(stops, x)
				table.insert(stops, y)
			end
		end
		if #stops == 0 then
			return
		end
		-- Патруль — приказ без конца: очередь он забывает.
		local fighters = fightersOf(ctx, player, args.units)
		queue.forget(ctx, fighters)
		for _, e in fighters do
			-- Изменения мира — после приказа: заведённая тут тактика ещё не видна.
			local own = ctx:get(e, "Tactics")
			if not own then
				ctx:add(e, "Tactics", {})
				own = { patrol = {} }
			end
			if args.append and #own.patrol > 0 then
				local patrol = {}
				for _, value in own.patrol do
					table.insert(patrol, value)
				end
				local room = math.max(0, (limit + 1) * 2 - #patrol)
				for i = 1, math.min(room, #stops) do
					table.insert(patrol, stops[i])
				end
				ctx:set(e, "Tactics", { patrol = patrol })
				continue
			end
			local at = ctx:get(e, "Position")
			local patrol = { math.floor(at.x), math.floor(at.y) }
			for _, value in stops do
				table.insert(patrol, value)
			end
			ctx:set(e, "Tactics", { patrol = patrol, leg = 1, away = false })
			ctx:move(e, stops[1], stops[2])
		end
	end,
}

mechanic.systems = {
	-- После боя: вставшие юниты без цели продолжают патруль или возвращаются на место, откуда ушли в погоню (patrol).
	-- Дошедший до точки патруля идёт к следующей.
	patrol = {
		query = { "Tactics", "Position" },
		after = { "fight" },
		run = function(q, ctx)
			local data = mechanic.data
			local turrets: { [number]: { number } }? = nil
			local moves: { { entity: number, x: number, y: number, leg: number?, count: number? } } = {}
			for i = 0, q.n - 1 do
				local entity = buffer.readf64(q.entity, i * 8)
				if (ctx.tick + entity) % data.resumeTicks ~= 0 or ctx:has(entity, "Path") then
					continue
				end
				local own = ctx:get(entity, "Tactics")
				-- Идущего за боеприпасами ведёт снабжение: на место он вернётся, когда наполнит магазин.
				if own.resupply or (#own.patrol == 0 and not own.away) then
					continue
				end
				turrets = turrets or tactics.mounts(ctx)
				if fighting(ctx, entity, (turrets :: any)[entity]) then
					continue
				end
				local x, y = buffer.readf64(q.Position.x, i * 8), buffer.readf64(q.Position.y, i * 8)
				local patrol = own.patrol
				if #patrol > 0 then
					local count = #patrol / 2
					local leg = own.leg
					-- Дошёл до точки — к следующей; встал, не дойдя (после боя), — снова к ней.
					if math.floor(x) == patrol[leg * 2 + 1] and math.floor(y) == patrol[leg * 2 + 2] then
						leg = (leg + 1) % count
						ctx:set(entity, "Tactics", { leg = leg })
					end
					table.insert(moves, { entity = entity, x = patrol[leg * 2 + 1], y = patrol[leg * 2 + 2], leg = leg, count = count })
				elseif math.sqrt((x - own.homeX - 0.5) ^ 2 + (y - own.homeY - 0.5) ^ 2) <= data.homeReach then
					-- Пришёл — или встал рядом, потому что место заняли.
					ctx:set(entity, "Tactics", { away = false })
				else
					-- Не пришёл — идёт туда снова: встреченный по дороге враг места назначения не отменяет.
					table.insert(moves, { entity = entity, x = own.homeX, y = own.homeY })
				end
			end
			for _, move in moves do
				ctx:move(move.entity, move.x, move.y)
				if ctx:has(move.entity, "Path") then
					continue
				end
				local leg, count = move.leg, move.count
				if leg and count then
					-- Ближе к точке патруля не подойти (она на здании, за обрывом): точка засчитана, юнит идёт к
					-- следующей. Иначе он искал бы путь к ней каждые resumeTicks.
					ctx:set(move.entity, "Tactics", { leg = (leg + 1) % count })
				else
					-- До места не добраться — остаётся где стоит.
					ctx:set(move.entity, "Tactics", { away = false })
				end
			end
		end,
	},
}

return mechanic
