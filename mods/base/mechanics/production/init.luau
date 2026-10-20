--!strict
-- Производство: здание с Producer выпускает юнитов за кредиты. Заказ платится сразу, очередь — по одному. Готовый юнит
-- появляется на ближайшем свободном тайле вокруг здания, а есть точка сбора — едет туда группой из одного; выйти некуда
-- — ждёт внутри. Приказы: produce, cancel, rally.

local wallet = require("lib/wallet")
local economy = require("lib/economy")
local goods = require("lib/goods")
local logistics = require("lib/logistics")
local construction = require("lib/construction")

local readf64, writef64 = buffer.readf64, buffer.writef64

local kinds = require("lib/kinds")

local production = {}

-- Кусок панели игрока (ui/hud).
production.panel = require("./panel")

production.data = {
	-- Сколько заказов держит очередь.
	queue = 5,
	-- Сколько свободных тайлов вокруг смотреть, куда выпустить готового.
	exits = 24,
	-- Сколько груза держит производитель без своего склада.
	hold = 100,
}

-- Сколько места в лимите армии занято у игрока: его юниты и заказы во всех его очередях.
function production.army(w, player: number): number
	local used = 0
	for _, e in w:each({ "Unit", "Owner", "Proto" }) do
		local kind = kinds.of(w, e)
		if w:get(e, "Owner").player == player and kind and kind.data.supply then
			used += kind.data.supply
		end
	end
	for _, e in w:each({ "Producer", "Owner" }) do
		if w:get(e, "Owner").player == player then
			local producer = w:get(e, "Producer")
			for _, name in { producer.unit, table.unpack(producer.queue) } do
				local unit = w.protos.units[name]
				used += if unit then unit.data.supply or 0 else 0
			end
		end
	end
	return used
end

-- Лимит армии партии (Rules.armyLimit); ноль — лимита нет.
function production.limit(w): number
	local rules = w.game.data and w.game.data.rules or {}
	return rules.armyLimit or 0
end

-- Не влезет ли юнит name в лимит армии игрока.
function production.overLimit(w, player: number, name: string): boolean
	local limit = production.limit(w)
	local unit = w.protos.units[name]
	return limit > 0 and unit ~= nil and production.army(w, player) + (unit.data.supply or 0) > limit
end

-- Ближайший к тайлу (x, y) проходимый тайл, в котором не стоит другой юнит; сам тайл не в счёт.
local function emptyTileNear(ctx, x: number, y: number): (number?, number?)
	local taken = {}
	local q = ctx:query({ "Unit", "Position" })
	for i = 0, q.n - 1 do
		taken[math.floor(readf64(q.Position.x, i * 8)) .. ":" .. math.floor(readf64(q.Position.y, i * 8))] = true
	end
	local tiles = ctx:free_tiles(x, y, production.data.exits, 1)
	for i = 1, #tiles, 2 do
		if not taken[tiles[i] .. ":" .. tiles[i + 1]] then
			return tiles[i], tiles[i + 1]
		end
	end
	return nil, nil
end

production.components = {
	-- unit — вид, который делается (пусто — ничего), progress — сколько секунд уже идёт, queue — что заказано следом,
	-- точка сбора — rallyX, rallyY, если rally.
	Producer = { unit = "", progress = 0, queue = {}, rally = false, rallyX = 0, rallyY = 0 },
}

-- Снаряжение вида: производитель ведёт заказы, а без своего склада получает склад под их материалы (hold).
function production.equip(kind, entity)
	if kind.data.produces then
		entity.Producer = {}
		entity.Inventory = entity.Inventory or goods.stock({ inventory = production.data.hold })
	end
end

-- Своё здание с Producer, которое умеет делать unit; иначе nil.
local function producer(ctx, player: number, building: number, unit: string?)
	if type(building) ~= "number" or not ctx:alive(building) then
		return nil
	end
	local owner = ctx:get(building, "Owner")
	local state = ctx:get(building, "Producer")
	-- Недостроенное и разбираемое не производит.
	if not owner or owner.player ~= player or not state or ctx:has(building, "Site") then
		return nil
	end
	if unit then
		local kind = ctx:proto(ctx:get(building, "Proto").id)
		if not table.find(kind.data.produces or {}, unit) or not ctx.protos.units[unit] then
			return nil
		end
	end
	return state
end

production.commands = {
	-- { building, unit } — заказать юнит; кредиты списываются сразу.
	produce = function(ctx, player, args)
		local state = producer(ctx, player, args.building, args.unit)
		if not state then
			return
		end
		local queue = state.queue
		local busy = if state.unit ~= "" then 1 else 0
		if #queue + busy >= production.data.queue then
			return
		end
		local unit = ctx.protos.units[args.unit]
		-- Юнит, чьё исследование не открыто или чьих зданий нет, не заказать.
		if not construction.researched(ctx, player, unit.data.research) or (construction.rules(ctx).techTree and #construction.missing(ctx, player, unit.data.requires) > 0) then
			return
		end
		-- Сверх лимита армии не заказать.
		if production.overLimit(ctx, player, args.unit) then
			ctx:signal("refused", { player = player, reason = "army" })
			return
		end
		if not wallet.pay(ctx, player, unit.data.cost) then
			ctx:signal("refused", { player = player, reason = "credits" })
			return
		end
		if state.unit == "" then
			ctx:set(args.building, "Producer", { unit = args.unit, progress = 0 })
		else
			table.insert(queue, args.unit)
			ctx:set(args.building, "Producer", { queue = queue })
		end
		ctx:signal("ordered", { player = player, building = args.building, unit = args.unit })
	end,

	-- { building } — снять последний заказ с возвратом кредитов.
	cancel = function(ctx, player, args)
		local state = producer(ctx, player, args.building)
		if not state then
			return
		end
		local queue = state.queue
		local unit = table.remove(queue)
		if unit then
			ctx:set(args.building, "Producer", { queue = queue })
		elseif state.unit ~= "" then
			unit = state.unit
			ctx:set(args.building, "Producer", { unit = "", progress = 0 })
			-- Начатый заказ уже забрал материалы: они возвращаются на склад производителя.
			local stock = ctx:get(args.building, "Inventory")
			local materials = ctx.protos.units[unit].data.materials
			if state.progress > 0 and stock and materials then
				for good, amount in materials do
					goods.put(stock, good, amount)
				end
				ctx:set(args.building, "Producer", { unit = "", progress = 0 })
				ctx:set(args.building, "Inventory", { items = stock.items })
			end
		end
		if unit then
			wallet.refund(ctx, player, ctx.protos.units[unit].data.cost)
		end
	end,

	-- { building, x, y } — точка сбора.
	rally = function(ctx, player, args)
		if producer(ctx, player, args.building) and type(args.x) == "number" and type(args.y) == "number" then
			ctx:set(args.building, "Producer", { rally = true, rallyX = math.floor(args.x), rallyY = math.floor(args.y) })
		end
	end,
}

production.on = {
	-- Новый юнит уже в мире: едет к точке сбора.
	rally = function(ctx, event)
		if ctx:alive(event.entity) then
			ctx:move_group({ event.entity }, event.x, event.y)
		end
	end,
}

production.systems = {
	produce = {
		query = { "Producer", "Position", "Owner" },
		write = { "Producer" },
		run = function(q, ctx)
			local p = q.Producer
			local entity = q.entity
			local empty = ctx:id("")
			for i = 0, q.n - 1 do
				local at = i * 8
				local current = readf64(p.unit, at)
				-- Пока здание сворачивается или разбирается, машина разворачивается или база свёрнута в MCV, производство стоит.
				local e = readf64(entity, at)
				if current == empty or ctx:has(e, "Converting") or ctx:has(e, "Unit") or ctx:has(e, "Site") then
					continue
				end
				local unit = ctx.protos.units[ctx:text(current)]
				-- Потребитель энергии при её нехватке работает на долю, вне сети и выключенный — стоит.
				local progress = readf64(p.progress, at)
				if progress <= 0 and unit.data.materials then
					-- Заказ начинается, когда его материалы на месте, и сразу их тратит.
					local stock = ctx:get(e, "Inventory")
					if not stock or next(logistics.missing(ctx, e)) ~= nil then
						continue
					end
					for good, amount in unit.data.materials do
						goods.take(stock, good, amount)
					end
					ctx:set(e, "Inventory", { items = stock.items })
					-- Материалы потрачены — заказ начат, даже если энергии сейчас нет.
					progress = 1e-9
				end
				if progress < unit.data.buildTime then
					progress = math.min(unit.data.buildTime, progress + ctx.dt * economy.shareOf(ctx, e))
				end
				if progress < unit.data.buildTime then
					writef64(p.progress, at, progress)
					continue
				end
				-- Готово: юнит на свободном тайле вокруг середины здания; выйти некуда — ждёт внутри.
				local building = readf64(entity, at)
				local tileX, tileY = emptyTileNear(ctx, math.floor(readf64(q.Position.x, at)), math.floor(readf64(q.Position.y, at)))
				if not tileX then
					writef64(p.progress, at, unit.data.buildTime)
					continue
				end
				local ox, oy = tileX + 0.5, tileY + 0.5
				local player = readf64(q.Owner.player, at)
				local made = ctx:spawn(unit, { Position = { x = ox, y = oy }, Owner = { player = player } })
				-- Есть точка сбора — готовый едет туда, на свободное место рядом с ней.
				if readf64(p.rally, at) ~= 0 then
					ctx:emit("rally", { entity = made, x = readf64(p.rallyX, at), y = readf64(p.rallyY, at) })
				end
				ctx:signal("produced", { player = player, building = building, unit = unit.name, entity = made, x = ox, y = oy })
				ctx:emit("reward", { player = player, key = "unit" })
				-- Следующий из очереди.
				local queue = ctx:get(building, "Producer").queue
				local next = table.remove(queue, 1)
				writef64(p.progress, at, 0)
				writef64(p.unit, at, if next then ctx:id(next) else empty)
				ctx:set(building, "Producer", { queue = queue })
			end
		end,
	},
}

-- На клиенте: машина выехала из завода — шипит воротина и катится рольставня, и своему игроку — уведомление «машина
-- готова»; отказ — жужжание.
production.signals = {
	produced = function(c, signal)
		local at = c:get(signal.building, "Position")
		if at then
			c:sound("rollout", { x = at.x, y = at.y, volume = 0.45 })
		end
		if signal.player == c.player then
			c:sound("unitReady", { volume = 0.4 })
		end
	end,
	refused = function(c, signal)
		if signal.player == c.player then
			c:sound("deny", { volume = 0.35 })
		end
	end,
}

-- По сети: очередь завода — только хозяину.
production.net = { Producer = "owner" }

return production
