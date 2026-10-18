--!strict
-- Снабжение войск. У юнита магазин (Magazine движка), выстрел тратит из него свою долю, пустой юнит молчит — это
-- считает бой движка, цены — lib/supply. Здесь — откуда берутся боеприпасы:
-- - в своей сети — внутри её кругов — магазин сам пополняется из её хранилищ;
-- - вне сети магазины пополняет машина снабжения (data.supplies): всем своим в её радиусе — со своего склада. Её склад
--   наполняют грузовики по её заявке (lib/logistics), хранилища сети, в кругах которой она стоит, и станция поставки
--   (data.depot) — своим лучом, вчетверо быстрее хранилищ;
-- - авиация в кругах сети не пополняется: только над своим аэродромом (data.rearms) — из хранилищ его сети — или у
--   машины снабжения.
-- Пустой юнит вне снабжения по стойке: держащий позицию стоит и ждёт, остальные сами идут к ближайшему снабжению, а
-- наполнив магазин, возвращаются на место, откуда ушли (Tactics.away, mechanics/tactics). Турели зданий стреляют со
-- склада: перед боем их магазин — запас склада, после боя расстрелянное списывается со склада.

local beams = require("lib/beam")
local goods = require("lib/goods")
local kinds = require("lib/kinds")
local logistics = require("lib/logistics")
local supply = require("lib/supply")
local tactics = require("lib/tactics")

local readf64 = buffer.readf64
local EPSILON = 1e-9

local mechanic = {}

mechanic.data = {
	-- Раз во сколько тиков пополняются магазины.
	ticks = 10,
	-- Раз во сколько проходов пустой ищет снабжение, а идущий за ним и не дошедший — ищет заново: поиск пути дорог, а
	-- снабжения может и не быть.
	seekPasses = 4,
	reseekPasses = 10,
	-- На сколько тайлов от края хранилища достаточно подойти: пополняет вся сеть; насколько ближе края раздачи встаёт
	-- идущий к машине снабжения; на сколько тайлов от края аэродрома авиация ещё над ним; дальше скольких тайлов от
	-- машины станцию поставки не ищут.
	seekNear = 2,
	supplierMargin = 1.5,
	airfieldReach = 1,
	depotReach = 4,
}

-- Уходит с места за снабжением: запоминает, куда вернуться, если ещё не помнит и не патрулирует.
local function leaveHome(ctx, entity: number, own)
	if own and (own.away or #own.patrol > 0) then
		return nil
	end
	local at = ctx:get(entity, "Position")
	return { away = true, homeX = math.floor(at.x), homeY = math.floor(at.y) }
end

mechanic.systems = {
	-- После грузовиков и до боя: станции поставки грузят машины снабжения каждый тик, раз в ticks магазины юнитов
	-- пополняются, пустые идут за боеприпасами, наполнившие возвращаются (supply).
	supply = {
		query = { "Unit", "Magazine", "Position", "Owner" },
		after = { "haul" },
		before = { "fight" },
		run = function(q, ctx)
			if not supply.enabled(ctx) then
				return
			end
			local d = mechanic.data
			local w = goods.book(ctx, { "Inventory", "Beam" })
			-- Машины снабжения.
			local suppliers = {}
			for _, e in ctx:each({ "Unit", "Inventory", "Owner", "Position" }) do
				local kind = kinds.of(ctx, e)
				local serves = kind and kind.data.supplies
				if serves then
					local at = ctx:get(e, "Position")
					table.insert(suppliers, { entity = e, player = ctx:get(e, "Owner").player, x = at.x, y = at.y, radius = serves.radius, rate = serves.rate })
				end
			end
			-- Станции поставки грузят машины своим лучом — каждый тик: луч рисуется по связям этого тика.
			for _, supplier in suppliers do
				if goods.room(w:get(supplier.entity, "Inventory"), "ammo") <= EPSILON then
					continue
				end
				local reach = math.ceil(supplier.radius + d.depotReach)
				local seen = {}
				local cx, cy = math.floor(supplier.x), math.floor(supplier.y)
				for y = cy - reach, cy + reach do
					for x = cx - reach, cx + reach do
						local depot = ctx:occupant(x, y)
						if not depot or seen[depot] then
							continue
						end
						seen[depot] = true
						if logistics.dataOf(ctx, depot).depot and logistics.isReady(ctx, supplier.player, depot) and beams.reaches(w, depot, supplier.entity) then
							beams.transfer(w, depot, supplier.entity, "ammo")
						end
					end
				end
			end
			if ctx.tick % d.ticks ~= 0 then
				w:flush()
				return
			end
			local seconds = d.ticks * ctx.dt
			-- Проход — раз в ticks, поэтому очередь юнитов считается проходами.
			local pass = ctx.tick // d.ticks
			local function onPass(entity: number, passes: number): boolean
				return (pass + entity) % passes == 0
			end
			local flows = nil
			-- Сколько ещё можно взять с хранилища в этом проходе: сверх резерва и обещанного грузовикам.
			local left: { [number]: number } = {}
			local function leftIn(source: number): number
				local amount = left[source]
				if amount == nil then
					flows = flows or logistics.flows(ctx)
					local out = flows.outgoing[source]
					amount = math.max(0, logistics.given(w, source, "ammo") - (if out then out.ammo or 0 else 0))
					left[source] = amount
				end
				return amount :: number
			end
			-- Сети игроков и кто в них отдаёт боеприпасы.
			local zones: { [number]: { any } } = {}
			for _, network in ctx:networks() do
				zones[network.player] = zones[network.player] or {}
				table.insert(zones[network.player], network)
			end
			local offering: { [any]: { number } } = {}
			local function offers(zone): { number }
				local list = offering[zone]
				if not list then
					list = {}
					for _, member in zone.members do
						if table.find(logistics.offers(ctx, member), "ammo") then
							table.insert(list, member)
						end
					end
					offering[zone] = list
				end
				return list
			end
			local function stocked(zone): boolean
				for _, source in offers(zone) do
					if leftIn(source) > EPSILON then
						return true
					end
				end
				return false
			end
			-- Сеть игрока, в кругах которой точка: из тех, где круги перекрываются, — с боеприпасами.
			local function zoneAt(player: number, x: number, y: number)
				local found = nil
				for _, zone in zones[player] or {} do
					if supply.inCircles(zone.circles, x, y) then
						if stocked(zone) then
							return zone
						end
						found = found or zone
					end
				end
				return found
			end
			-- Берёт из хранилищ сети до amount боеприпасов; возвращает, сколько взято.
			local function takeFrom(zone, amount: number): number
				local taken = 0
				for _, source in offers(zone) do
					if amount - taken <= EPSILON then
						break
					end
					local part = goods.take(w:get(source, "Inventory"), "ammo", math.min(amount - taken, leftIn(source)))
					left[source] = leftIn(source) - part
					taken += part
				end
				return taken
			end
			-- Готовые аэродромы: где стоят и в какой сети.
			local airfields = nil
			local function airfieldsOf()
				if airfields then
					return airfields
				end
				airfields = {}
				for _, e in ctx:each({ "Building", "Owner", "Position" }) do
					local data = logistics.dataOf(ctx, e)
					local player = ctx:get(e, "Owner").player
					local zone = data.rearms and logistics.isReady(ctx, player, e) and logistics.networkOf(ctx, e)
					if zone then
						local at = ctx:get(e, "Position")
						table.insert(airfields, { player = player, x = at.x - data.width / 2, y = at.y - data.height / 2, width = data.width, height = data.height, zone = zone })
					end
				end
				return airfields
			end
			local function airfieldAt(player: number, x: number, y: number)
				for _, airfield in airfieldsOf() do
					if airfield.player == player and supply.gap(x, y, airfield.x, airfield.y, airfield.width, airfield.height) <= d.airfieldReach then
						return airfield.zone
					end
				end
				return nil
			end
			-- Ближайшая машина снабжения игрока с боеприпасами, в радиусе раздачи которой точка.
			local function supplierAt(player: number, x: number, y: number)
				local best, bestDistance = nil, math.huge
				for _, supplier in suppliers do
					if supplier.player ~= player or goods.amount(w:get(supplier.entity, "Inventory"), "ammo") <= EPSILON then
						continue
					end
					local distance = math.sqrt((supplier.x - x) ^ 2 + (supplier.y - y) ^ 2)
					if distance <= supplier.radius and distance < bestDistance then
						best, bestDistance = supplier, distance
					end
				end
				return best
			end

			-- Машины снабжения в кругах своей сети грузятся из её хранилищ.
			for _, supplier in suppliers do
				local stock = w:get(supplier.entity, "Inventory")
				local room = goods.room(stock, "ammo")
				if room <= EPSILON then
					continue
				end
				local zone = zoneAt(supplier.player, supplier.x, supplier.y)
				if zone then
					goods.put(stock, "ammo", takeFrom(zone, math.min(room, supply.SUPPLIER_LOAD * seconds)))
				end
			end

			local seekers = {}
			for i = 0, q.n - 1 do
				local at = i * 8
				local entity = readf64(q.entity, at)
				local kind = kinds.of(ctx, entity)
				local capacity = if kind then supply.magazineOf(kind) else 0
				if capacity == 0 then
					continue
				end
				local ammo = readf64(q.Magazine.ammo, at)
				local x, y = readf64(q.Position.x, at), readf64(q.Position.y, at)
				local player = readf64(q.Owner.player, at)
				local own = ctx:get(entity, "Tactics")
				local lacking = ammo < capacity - EPSILON
				-- Авиацию кормит сеть только над аэродромом.
				local zone = nil
				if lacking then
					zone = if kind.data.kind == "air" then airfieldAt(player, x, y) else zoneAt(player, x, y)
				end
				-- Вне сети магазин пополняет машина снабжения, в радиусе которой юнит стоит.
				local supplier = if lacking and not zone then supplierAt(player, x, y) else nil
				local filled = ammo
				if zone then
					filled += takeFrom(zone, math.min(capacity - ammo, supply.REFILL_RATE * seconds))
				elseif supplier then
					filled += goods.take(w:get(supplier.entity, "Inventory"), "ammo", math.min(capacity - ammo, supplier.rate * seconds))
				end
				if filled ~= ammo then
					ctx:set(entity, "Magazine", { ammo = filled })
				end
				if own and own.resupply then
					-- Наполнил — встаёт и возвращается, куда помнит (mechanics/tactics), и снова воюет по стойке. Путь у
					-- идущего за снабжением — всегда снабжения: приказ игрока снимает resupply (tactics.clear).
					if filled >= capacity - EPSILON then
						ctx:set(entity, "Tactics", { resupply = false })
						ctx:remove(entity, "Path")
					elseif not zone and not supplier and not ctx:has(entity, "Path") and onPass(entity, d.reseekPasses) then
						table.insert(seekers, entity)
					end
					continue
				end
				local least = readf64(q.Magazine.least, at)
				if zone or supplier or filled >= least - EPSILON then
					continue
				end
				-- Идущий по приказу идёт, куда велели: за боеприпасами он пойдёт, когда встанет.
				if ctx:has(entity, "Path") or tactics.stanceOf(ctx, entity) == "hold" or not onPass(entity, d.seekPasses) then
					continue
				end
				table.insert(seekers, entity)
			end

			-- Пустые — к ближайшему хранилищу своей сети, где есть боеприпасы, или к машине снабжения с ними; авиация — к
			-- аэродрому, в сети которого они есть, или к машине. Нет таких — ждут, где стоят.
			for _, entity in seekers do
				local player = ctx:get(entity, "Owner").player
				local at = ctx:get(entity, "Position")
				local bestX, bestY, near, bestDistance = nil, nil, 0, math.huge
				for _, supplier in suppliers do
					if supplier.player ~= player or supplier.entity == entity or goods.amount(w:get(supplier.entity, "Inventory"), "ammo") <= EPSILON then
						continue
					end
					local distance = math.sqrt((supplier.x - at.x) ^ 2 + (supplier.y - at.y) ^ 2)
					if distance < bestDistance then
						bestX, bestY, bestDistance = supplier.x, supplier.y, distance
						near = math.max(0, supplier.radius - d.supplierMargin)
					end
				end
				if kinds.of(ctx, entity).data.kind == "air" then
					for _, airfield in airfieldsOf() do
						if airfield.player ~= player or not stocked(airfield.zone) then
							continue
						end
						local cx, cy = airfield.x + airfield.width / 2, airfield.y + airfield.height / 2
						local distance = math.sqrt((cx - at.x) ^ 2 + (cy - at.y) ^ 2)
						if distance < bestDistance then
							bestX, bestY, bestDistance = cx, cy, distance
							near = math.min(airfield.width, airfield.height) / 2
						end
					end
				else
					for _, zone in zones[player] or {} do
						if not stocked(zone) then
							continue
						end
						for _, source in offers(zone) do
							if leftIn(source) <= EPSILON then
								continue
							end
							local center = ctx:get(source, "Position")
							local data = logistics.dataOf(ctx, source)
							local distance = math.sqrt((center.x - at.x) ^ 2 + (center.y - at.y) ^ 2)
							if distance < bestDistance then
								bestX, bestY, bestDistance = center.x, center.y, distance
								near = math.max(data.width or 1, data.height or 1) / 2 + d.seekNear
							end
						end
					end
				end
				if not bestX then
					continue
				end
				local own = ctx:get(entity, "Tactics")
				local home = leaveHome(ctx, entity, own)
				ctx:move(entity, math.floor(bestX), math.floor(bestY :: number), near)
				local going = ctx:has(entity, "Path")
				local fields = home or {}
				if going then
					fields.resupply = true
				end
				if next(fields) == nil then
					continue
				end
				if own then
					ctx:set(entity, "Tactics", fields)
				else
					ctx:add(entity, "Tactics", fields)
				end
			end
			w:flush()
		end,
	},

	-- Перед боем: магазин турелей здания — запас боеприпасов на его складе.
	arm = {
		query = { "Magazine", "Building", "Inventory" },
		after = { "supply" },
		before = { "fight" },
		write = { "Magazine" },
		run = function(q, ctx)
			for i = 0, q.n - 1 do
				local entity = readf64(q.entity, i * 8)
				local stock = ctx:get(entity, "Inventory")
				buffer.writef64(q.Magazine.ammo, i * 8, goods.amount(stock, "ammo"))
			end
		end,
	},
	-- После боя: расстрелянное турелями здания списывается с его склада.
	spend = {
		query = { "Magazine", "Building", "Inventory" },
		after = { "fight" },
		before = { "rest" },
		run = function(q, ctx)
			for i = 0, q.n - 1 do
				local entity = readf64(q.entity, i * 8)
				local stock = ctx:get(entity, "Inventory")
				local ammo = readf64(q.Magazine.ammo, i * 8)
				if math.abs(goods.amount(stock, "ammo") - ammo) > EPSILON then
					stock.items.ammo = ammo
					ctx:set(entity, "Inventory", { items = stock.items })
				end
			end
		end,
	},
}

mechanic.on = {
	-- Партия без боеприпасов юнитов (unitAmmo = false): юниты стреляют бесплатно — магазина у них нет.
	spawned = function(ctx, event)
		if not supply.enabled(ctx) and ctx:has(event.entity, "Unit") and ctx:has(event.entity, "Magazine") then
			ctx:remove(event.entity, "Magazine")
		end
	end,
}

return mechanic
