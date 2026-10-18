--!strict
-- Приказы юнитам — перенос case 'move' из packages/sim-ts/src/commands.ts: свои юниты группой едут к тайлу, каждый на
-- своё место рядом с ним (ctx:move_group — orderGroupMove движка); стоп — снять путь. Приказ точкой (order,
-- resolveOrder в target.ts) решает хост: строители по своей стройке или повреждённому — строят и чинят, иначе — едут.
-- Вооружённые по видимому врагу — атакуют. С Shift (queue) приказ встаёт юнитам в очередь (lib/queue), и система follow
-- раздаёт его, когда они освободятся (followOrders в orders.ts).

local conversion = require("lib/conversion")
local construction = require("lib/construction")
local logistics = require("lib/logistics")
local tactics = require("lib/tactics")
local queue = require("lib/queue")
local drops = require("lib/drops")

local orders = {}

-- Свои живые юниты из списка, без повторов.
local function own(ctx, player: number, units: any): { number }
	local list, seen = {}, {}
	if type(units) ~= "table" then
		return list
	end
	for _, entity in units do
		if type(entity) == "number" and not seen[entity] and ctx:alive(entity) and ctx:has(entity, "Mover") then
			seen[entity] = true
			local owner = ctx:get(entity, "Owner")
			if owner and owner.player == player then
				table.insert(list, entity)
			end
		end
	end
	return list
end

-- Насколько мимо юнита можно попасть точкой приказа, чтобы всё равно попасть в него, в тайлах (ORDER_MARGIN).
orders.data = { margin = 0.3 }

-- Юнит под точкой: ближайший из тех, в чей круг с запасом она попала (unitNear); own — среди своих или чужих.
-- Чужого, которого игрок сейчас не видит, нет.
local function unitNear(ctx, player: number, x: number, y: number, own: boolean): number?
	local best, bestDistance = nil, math.huge
	for _, e in ctx:each({ "Unit", "Position", "Mover", "Owner" }) do
		if (ctx:get(e, "Owner").player == player) ~= own then
			continue
		end
		local at = ctx:get(e, "Position")
		local distance = math.sqrt((at.x - x) ^ 2 + (at.y - y) ^ 2)
		if distance <= ctx:get(e, "Mover").radius + orders.data.margin and distance < bestDistance then
			if own or ctx:sees(player, at.x, at.y) then
				best, bestDistance = e, distance
			end
		end
	end
	return best
end

-- Свои юниты едут к тайлу: приказ идти снимает строителя со стройки, грузовик — с работы и шахты, бойца — с цели и
-- патруля. Агрессивные идут походом: по дороге бьют увиденных врагов и продолжают путь.
local function move(ctx, player: number, units: { number }, x: number, y: number)
	queue.forget(ctx, units)
	for _, e in units do
		ctx:remove(e, "Builds")
		tactics.stopAttack(ctx, e)
		tactics.clear(ctx, e)
	end
	ctx:emit("release", { units = units })
	ctx:move_group(units, x, y)
	tactics.march(ctx, units)
	conversion.forget(ctx, units)
	ctx:signal("moved", { player = player, x = x, y = y })
end

orders.commands = {
	-- { units, x, y } — приказ точкой (в тайлах, можно дробной): что с ней делать, решает хост. Точка в тумане — всегда
	-- движение: что там стоит, игрок не знает.
	order = function(ctx, player, args)
		if type(args.x) ~= "number" or type(args.y) ~= "number" then
			return
		end
		local units = own(ctx, player, args.units)
		if #units == 0 then
			return
		end
		local x, y = math.floor(args.x), math.floor(args.y)
		-- Что решено: с Shift — в очередь, иначе — сразу (событием той механики, чей это приказ).
		local function act(name: string, event: { [string]: any })
			if args.queue then
				queue.push(ctx, player, name, event, units)
				return
			end
			queue.forget(ctx, units)
			event.player, event.units = player, units
			ctx:emit(name, event)
		end
		if ctx:sees(player, x, y) then
			-- Работа для строителей: стройка, разбор, своё повреждённое — здание или юнит — или улучшаемое здание.
			local planned = construction.siteAt(ctx, x, y)
			local broken = unitNear(ctx, player, args.x, args.y, true) or ctx:occupant(x, y)
			local fixable = broken and (construction.canRepair(ctx, player, broken) or ctx:has(broken, "Upgrade"))
			local site = planned or (if fixable then broken else nil)
			local builders = false
			for _, e in units do
				builders = builders or ctx:has(e, "Repair")
			end
			-- Вооружённые по врагу — атакуют: по чужому юниту или зданию в точке.
			local enemy = unitNear(ctx, player, args.x, args.y, false) or ctx:occupant(x, y)
			local turrets = tactics.mounts(ctx)
			local fighters = false
			for _, e in units do
				fighters = fighters or tactics.canFight(ctx, e, turrets[e])
			end
			if fighters and enemy and tactics.canAttack(ctx, player, enemy) then
				act("attack", { target = enemy })
				return
			end
			-- Грузовики по своей шахте — привязываются к ней и возят добытое.
			local trucks = false
			for _, e in units do
				trucks = trucks or ctx:has(e, "Hauler")
			end
			local mine = ctx:occupant(x, y)
			if trucks and mine and logistics.isReady(ctx, player, mine) and logistics.dataOf(ctx, mine).extract then
				act("haul", { mine = mine })
				return
			end
			-- Грузовики по дропу — вывозят его.
			local drop = trucks and drops.at(ctx, x, y)
			if drop then
				act("pickup", { drop = drop })
				return
			end
			if site and builders and ctx:get(site, "Owner").player == player then
				act("assist", { site = site })
				return
			end
		end
		if args.queue then
			queue.push(ctx, player, "move", { x = x, y = y }, units)
			return
		end
		move(ctx, player, units, x, y)
	end,

	-- { units = { сущности }, x, y } — свои юниты едут к тайлу.
	move = function(ctx, player, args)
		if type(args.x) ~= "number" or type(args.y) ~= "number" then
			return
		end
		local units = own(ctx, player, args.units)
		if #units == 0 then
			return
		end
		if args.queue then
			queue.push(ctx, player, "move", { x = args.x, y = args.y }, units)
			return
		end
		move(ctx, player, units, args.x, args.y)
	end,

	-- { units } — стоять: без пути, работы, цели и патруля.
	stop = function(ctx, player, args)
		local units = own(ctx, player, args.units)
		queue.forget(ctx, units)
		for _, entity in units do
			ctx:stop(entity)
			ctx:remove(entity, "Builds")
			tactics.stopAttack(ctx, entity)
			tactics.clear(ctx, entity)
		end
		ctx:emit("release", { units = units })
		conversion.forget(ctx, units)
	end,
}

orders.components = {
	-- Очередь приказов юнита (lib/queue): list — по порядку { group, name, args }.
	Orders = { list = {} },
}

-- Занят делом, у которого нет конца: грузовик при шахте, боец в патруле. Ждать, пока оно кончится, нечего — приказ из
-- очереди его прерывает, как прервал бы приказ без Shift (endless).
local function endless(ctx, e: number): boolean
	local hauler = ctx:get(e, "Hauler")
	if hauler and hauler.mine >= 0 then
		return true
	end
	local state = ctx:get(e, "Tactics")
	return state ~= nil and #state.patrol > 0
end

-- Нечем занят: не едет, не строит, не превращается, не гонится за целью по приказу и не возвращается после погони.
-- Дело без конца — не в счёт (idle).
local function idle(ctx, e: number, turrets: { [number]: { number } }): boolean
	if endless(ctx, e) then
		return true
	end
	if ctx:has(e, "Path") or ctx:has(e, "Builds") or ctx:has(e, "Converting") then
		return false
	end
	for _, gunner in { e, table.unpack(turrets[e] or {}) } do
		local armed = ctx:get(gunner, "Armed")
		if armed and armed.ordered and armed.target >= 0 then
			return false
		end
	end
	local state = ctx:get(e, "Tactics")
	if state and state.away then
		return false
	end
	-- Грузовик, который вывозит дроп, занят, пока тот не опустеет.
	local hauler = ctx:get(e, "Hauler")
	return not (hauler and hauler.pickup >= 0)
end

-- Приказы механик по имени — как их зовёт приказ игрока.
local handlers: { [string]: any }? = nil
local function handlerOf(ctx, name: string)
	if not handlers then
		local found = {}
		for _, kind in ctx.protos.mechanics do
			for command, handler in (if type(kind) == "table" and type(kind.commands) == "table" then kind.commands else {}) do
				found[command] = handler
			end
		end
		handlers = found
	end
	return (handlers :: { [string]: any })[name]
end

orders.systems = {
	-- Раз в тик освободившиеся юниты берут следующий приказ из очереди (followOrders). Приказ группы ждёт, пока
	-- освободятся все её юниты, у которых он следующий, — тогда они получают его вместе и встают строем.
	follow = {
		every = 1,
		run = function(_, ctx)
			local groups, order = {}, {}
			local turrets = nil
			for _, e in ctx:each({ "Orders", "Owner" }) do
				local list = ctx:get(e, "Orders").list
				local head = list[1]
				if not head then
					continue
				end
				turrets = turrets or tactics.mounts(ctx)
				local group = groups[head.group]
				if not group then
					group = { player = ctx:get(e, "Owner").player, head = head, units = {}, rests = {}, ready = true }
					groups[head.group] = group
					table.insert(order, head.group)
				end
				table.insert(group.units, e)
				table.insert(group.rests, { table.unpack(list, 2) })
				group.ready = group.ready and idle(ctx, e, turrets)
			end
			for _, key in order do
				local group = groups[key]
				local handler = group.ready and handlerOf(ctx, group.head.name)
				if not handler then
					continue
				end
				-- Приказ забывает очередь, как любой без Shift: остаток кладётся обратно после него.
				local args = queue.copy(group.head.args)
				args.units = group.units
				handler(ctx, group.player, args)
				for i, e in group.units do
					ctx:set(e, "Orders", { list = group.rests[i] })
				end
			end
		end,
	},
}

return orders
