--!strict
-- Грузовики. Груз между складом и грузовиком переносит луч грузовика: ему достаточно встать в радиусе, очередей нет.
-- Добывают и перерабатывают шахты и переработки сами (mechanics/mining). Работа грузовика — ./trucks, диспетчер —
-- ./dispatch, приказы игрока и маршруты — ./orders, числа — ./data.
--
-- Привязанный к шахте грузовик (приказ haul) возит её руду на переработку. Свободному работу даёт диспетчер: подвезти
-- заказанное или увезти готовое из переработки в хранилище (lib/logistics). Работа — забрать груз со склада from и
-- сгрузить на склад to. Пропал склад, кончился груз или место — грузовик ищет другой или бросает работу.
--
-- Дропы (lib/drops) в своих зонах свободные грузовики вывозят сами, приказ pickup — где бы те ни лежали. Груз, который
-- некуда везти, потому что к принимающему не подъехать, грузовик бросает на землю.
--
-- Приказы игрока: маршрут — здания-остановки по кругу; обслуживание — возить только по заявкам этих зданий, беря груз
-- где угодно у игрока; «обеспечить» — то же для одного здания, пока его заявки не кончатся; ручная перевозка (Carry) —
-- взять здесь, отвезти туда; фильтр — какие грузы возить; резерв хранилищ и заказ станций запроса. Пока нет: нормы
-- поиска подъезда на тик.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local beams = require("lib/beam")
local queue = require("lib/queue")
local drops = require("lib/drops")
local world = require("lib/world")
local trucks = require("./trucks")
local orders = require("./orders")
local dispatch = require("./dispatch").dispatch
local canHaul, carriedBy, dropJob, release, freed, canPickup, unload, blockedTaker, returnsTo, requesterFor, seekDue, seek, isSpent = trucks.canHaul, trucks.carriedBy, trucks.dropJob, trucks.release, trucks.freed, trucks.canPickup, trucks.unload, trucks.blockedTaker, trucks.returnsTo, trucks.requesterFor, trucks.seekDue, trucks.seek, trucks.isSpent
local assign, assignPickup, trucksOf, assignSupply, runRoutes, runCarry = orders.assign, orders.assignPickup, orders.trucksOf, orders.assignSupply, orders.runRoutes, orders.runCarry
local reaches, transfer = beams.reaches, beams.transfer
local RELEASED = trucks.RELEASED

local mechanic = {}

-- Кусок панели игрока (ui/hud).
mechanic.panel = require("./panel")

local NONE = -1
local EPSILON = goods.EPSILON

mechanic.data = require("./data")

mechanic.components = {
	-- Склад: груз → сколько, объём, что сюда кладут, пределы, резерв хранилища (lib/goods).
	Inventory = { items = {}, capacity = 0, accepts = {}, limits = {}, reserve = 0 },
	-- Транспортный луч: переносит груз между своим складом и чужим, если между краями не больше radius; give — умеет
	-- отдавать, take — забирать, rate — единиц в секунду на склад; links — с кем работал в этот тик (подаче).
	Beam = { radius = 2, rate = 10, give = true, take = true, links = {} },
	-- Грузовик: mine — шахта, к которой привязан; работа — до amount груза resource со склада from на склад to; full —
	-- набрал и едет к to; loading — грузится или сгружается в этот тик; waiting — уже ищет подъезд; misses — промахи
	-- подъезда подряд; filter — что возит (пусто — всё); trapped — обстроен и выехать ему некуда; pickup — дроп, который
	-- велено вывезти; route — остановки маршрута по кругу, stop — к какой едет сейчас; serve — здания, которые он
	-- обслуживает; supply — здание, которое велено обеспечить.
	Hauler = { mine = -1, from = -1, to = -1, resource = "", amount = 0, full = false, loading = false, waiting = false, misses = 0, filter = {}, trapped = false, pickup = -1, route = {}, stop = 0, serve = {}, supply = -1 },
	-- Ручной приказ грузовику: left груза resource со склада from (-1 — что уже в кузове) на склад to; full — набрал и
	-- едет к получателю.
	Carry = { from = -1, to = -1, resource = "", left = 0, full = false },
	-- Заказ станции запроса: груз → сколько держать.
	Wanted = { items = {} },
	-- Грузовикам игрока не подъехать к этому зданию до тика until: работы сюда не дают, игрок видит значок.
	Unreachable = { ["until"] = 0 },
}

-- Снаряжение вида: станция запроса держит заказанное игроком, у кого data.beam — транспортный луч, грузовик (data.hauls)
-- работает.
function mechanic.equip(kind, entity)
	local data = kind.data
	if data.requester then
		entity.Wanted = {}
	end
	if data.beam then
		entity.Beam = { radius = data.beam.radius, rate = data.beam.rate, give = data.beam.give == true, take = data.beam.take == true }
	end
	if data.hauls then
		entity.Hauler = {}
	end
end


mechanic.commands = {
	-- { units, stops } — маршрут своим грузовикам: свои готовые здания со складом по кругу, не больше routeLimit,
	-- подряд одинаковые склеиваются; меньше двух — маршрут снимается. Грузовик бросает прежние приказы; груз в кузове
	-- повезёт по маршруту.
	route = function(ctx, player, args)
		local trucks = trucksOf(ctx, player, args.units)
		if #trucks == 0 or type(args.stops) ~= "table" then
			return
		end
		local route = {}
		for i, stop in args.stops do
			if i > mechanic.data.routeLimit then
				break
			end
			if logistics.isStop(ctx, player, stop) and route[#route] ~= stop then
				table.insert(route, stop)
			end
		end
		if #route > 1 and route[1] == route[#route] then
			table.remove(route)
		end
		queue.forget(ctx, trucks)
		for _, truck in trucks do
			freed(ctx, truck, { route = if #route > 1 then route else {} })
		end
	end,
	-- { units, buildings } — своим грузовикам возить только по заявкам этих своих зданий, беря груз где угодно у
	-- игрока; пусто — снять обслуживание.
	serve = function(ctx, player, args)
		local trucks = trucksOf(ctx, player, args.units)
		if #trucks == 0 or type(args.buildings) ~= "table" then
			return
		end
		local serve, seen = {}, {}
		for _, building in args.buildings do
			if #serve < mechanic.data.serveLimit and not seen[building] and logistics.isStop(ctx, player, building) then
				seen[building] = true
				table.insert(serve, building)
			end
		end
		queue.forget(ctx, trucks)
		for _, truck in trucks do
			freed(ctx, truck, { serve = serve })
		end
	end,
	-- { units, goods } — какие грузы возить своим грузовикам; пусто — любые. Начатая работа с грузом, которого фильтр
	-- не пускает, бросается: набранное грузовик отвезёт в хранилище.
	filter = function(ctx, player, args)
		if type(args.goods) ~= "table" then
			return
		end
		local filter = {}
		for _, name in goods.names(ctx) do
			if table.find(args.goods, name) then
				table.insert(filter, name)
			end
		end
		for _, truck in trucksOf(ctx, player, args.units) do
			local hauler = ctx:get(truck, "Hauler")
			local fields: { [string]: any } = { filter = filter }
			if (hauler.from ~= NONE or hauler.to ~= NONE) and #filter > 0 and not table.find(filter, hauler.resource) then
				fields.from, fields.to, fields.amount = NONE, NONE, 0
				fields.full, fields.loading, fields.waiting = false, false, false
				ctx:stop(truck)
			end
			ctx:set(truck, "Hauler", fields)
		end
	end,
	-- { units, from, to, resource, amount } — перевезти amount груза resource из from в to (from = -1 — что уже в
	-- кузове): на всех грузовиков поровну.
	carry = function(ctx, player, args)
		local good, amount, from, to = args.resource, args.amount, args.from, args.to
		if type(good) ~= "string" or not table.find(goods.names(ctx), good) or type(amount) ~= "number" or amount <= 0 or amount ~= amount or from == to then
			return
		end
		if from ~= NONE and not logistics.isCarrySource(ctx, player, from) then
			return
		end
		if not logistics.isCarryTarget(ctx, player, to, good) then
			return
		end
		local trucks = trucksOf(ctx, player, args.units)
		if #trucks == 0 then
			return
		end
		local share = amount / #trucks
		queue.forget(ctx, trucks)
		for _, truck in trucks do
			freed(ctx, truck)
			local carried = goods.amount(ctx:get(truck, "Inventory"), good)
			ctx:add(truck, "Carry", { from = from, to = to, resource = good, left = if from == NONE then math.min(share, carried) else share, full = from == NONE })
		end
	end,
	-- { units, target } — обеспечить своё здание или стройку, которым нужен груз.
	supply = function(ctx, player, args)
		queue.forget(ctx, trucksOf(ctx, player, args.units))
		assignSupply(ctx, player, args.target, args.units)
	end,
	-- { buildings, amount } — резерв своих готовых хранилищ: столько груза они не выдают никому, кроме продажи; не больше
	-- вместимости, ноль — снять.
	reserve = function(ctx, player, args)
		if type(args.buildings) ~= "table" or type(args.amount) ~= "number" or args.amount ~= args.amount then
			return
		end
		for _, building in args.buildings do
			if type(building) == "number" and world.isReady(ctx, player, building) and logistics.isStore(ctx, building) then
				local stock = ctx:get(building, "Inventory")
				if stock then
					ctx:set(building, "Inventory", { reserve = math.max(0, math.min(stock.capacity, math.round(args.amount))) })
				end
			end
		end
	end,
	-- { buildings, resource, amount } — заказ своих станций запроса: сколько груза держать; ноль — не заказывать. Заказ
	-- всех грузов вместе не больше склада станции; руду не заказывают.
	want = function(ctx, player, args)
		local good = args.resource
		if type(good) ~= "string" or not table.find(goods.names(ctx), good) or goods.isOre(ctx, good) or type(args.amount) ~= "number" or args.amount ~= args.amount or type(args.buildings) ~= "table" then
			return
		end
		for _, building in args.buildings do
			if type(building) ~= "number" or not world.isReady(ctx, player, building) then
				continue
			end
			local wanted, stock = ctx:get(building, "Wanted"), ctx:get(building, "Inventory")
			if not wanted or not stock then
				continue
			end
			local others = 0
			for name, held in wanted.items do
				if name ~= good then
					others += held
				end
			end
			local items = table.clone(wanted.items)
			local nextAmount = math.max(0, math.min(stock.capacity - others, math.round(args.amount)))
			items[good] = if nextAmount > 0 then nextAmount else nil
			ctx:set(building, "Wanted", { items = items })
		end
	end,
	-- { mine, units, queue } — привязать свои грузовики к своей шахте: возят только её руду на переработку; с Shift — в
	-- очередь.
	haul = function(ctx, player, args)
		if type(args.mine) ~= "number" or type(args.units) ~= "table" then
			return
		end
		if args.queue then
			queue.push(ctx, player, "haul", { mine = args.mine }, args.units)
			return
		end
		queue.forget(ctx, args.units)
		assign(ctx, player, args.mine, args.units)
	end,
	-- { drop, units, queue } — вывезти дроп своими грузовиками; с Shift — в очередь.
	pickup = function(ctx, player, args)
		if type(args.drop) ~= "number" or type(args.units) ~= "table" then
			return
		end
		if args.queue then
			queue.push(ctx, player, "pickup", { drop = args.drop }, args.units)
			return
		end
		queue.forget(ctx, args.units)
		assignPickup(ctx, player, args.drop, args.units)
	end,
}

mechanic.on = {
	-- Приказ точкой (mechanics/orders): грузовики по своей шахте.
	haul = function(ctx, event)
		assign(ctx, event.player, event.mine, event.units)
	end,
	-- Приказ точкой: грузовики по дропу.
	pickup = function(ctx, event)
		assignPickup(ctx, event.player, event.drop, event.units)
	end,
	-- Приказ идти снимает грузовик с работы, шахты, маршрута и прочих приказов; груз остаётся в кузове.
	release = function(ctx, event)
		for _, truck in event.units do
			if ctx:alive(truck) and ctx:has(truck, "Hauler") then
				local values = table.clone(RELEASED)
				ctx:set(truck, "Hauler", values)
				ctx:remove(truck, "Carry")
			end
		end
	end,
	-- Приказ точкой: грузовики обеспечивают здание или стройку.
	supply = function(ctx, event)
		assignSupply(ctx, event.player, event.target, event.units)
	end,
}

mechanic.systems = {
	-- После стройки, труб и добычи и до боя: грузовики возят, диспетчер раздаёт работу.
	haul = {
		after = { "construct" },
		before = { "fight" },
		run = function(_, ctx)
			local d = mechanic.data
			local w = goods.book(ctx, { "Inventory", "Hauler", "Beam", "Carry" })
			-- Лучи забывают, с кем работали в прошлом тике.
			for _, e in ctx:each({ "Beam" }) do
				local beam = w:get(e, "Beam")
				if #beam.links > 0 then
					beam.links = {}
				end
			end

			local seeking, working, released, dropped, homeless = {}, {}, {}, {}, {}
			for _, truck in ctx:each({ "Hauler", "Owner", "Inventory" }) do
				local hauler = w:get(truck, "Hauler")
				local player = world.ownerOf(ctx, truck)
				local cargo = w:get(truck, "Inventory")
				hauler.loading = false
				-- Грузовик с маршрутом ездит по нему сам, с ручным приказом — по приказу.
				if #hauler.route > 0 or w:has(truck, "Carry") then
					continue
				end
				if hauler.mine ~= NONE and not canHaul(w, player, hauler.mine) then
					-- Шахты больше нет: грузовик свободен, груз остаётся в кузове.
					table.insert(released, truck)
					continue
				end
				if hauler.pickup ~= NONE and not canPickup(w, hauler.pickup) then
					-- Дроп вывезли или застроили: грузовик свободен.
					table.insert(released, truck)
					continue
				end
				if ctx:has(truck, "Path") or ctx:has(truck, "Converting") then
					continue
				end
				local retry = world.onTurn(ctx, truck, d.retryTicks)
				if hauler.from == NONE and hauler.to == NONE then
					local carried = carriedBy(w, truck)
					if carried then
						-- Остался груз — сначала в хранилище или переработку.
						hauler.resource, hauler.full = carried, true
					elseif hauler.mine ~= NONE then
						local ore = logistics.mineOre(w, hauler.mine)
						-- Шахта выработана и вывезена: грузовик свободен.
						if not ore or isSpent(w, hauler.mine) then
							table.insert(released, truck)
							continue
						end
						-- Руду, которую некуда везти, не берёт: ждёт у шахты. Место бронирует сразу.
						if not retry then
							continue
						end
						-- Переработку в сети шахты руда достигает по трубам: грузовик возит только в другие сети.
						local to = logistics.refineryFor(w, truck, ore, nil, logistics.networkOf(w, hauler.mine))
						if not to then
							continue
						end
						hauler.from, hauler.to, hauler.resource = hauler.mine, to, ore
						hauler.amount = math.min(cargo.capacity, logistics.space(w, to, ore, logistics.flows(w, truck)))
						hauler.full = false
					elseif hauler.pickup ~= NONE then
						-- Следующий рейс с дропа: первый груз, который пускает фильтр и которому есть куда ехать. Фильтр не
						-- пускает ничего из лежащего — приказ снимается; места нет нигде — грузовик ждёт.
						local drop = hauler.pickup
						local list = {}
						for _, good in logistics.offers(w, drop) do
							if #hauler.filter == 0 or table.find(hauler.filter, good) then
								table.insert(list, good)
							end
						end
						if #list == 0 then
							table.insert(released, truck)
							continue
						end
						if not retry then
							continue
						end
						local good, to = nil, nil
						for _, name in list do
							to = logistics.deliveryFor(w, truck, name)
							if to then
								good = name
								break
							end
						end
						if not good or not to then
							continue
						end
						hauler.from, hauler.to, hauler.resource = drop, to, good
						hauler.amount = math.min(cargo.capacity, logistics.space(w, to, good, logistics.flows(w, truck)), logistics.spare(w, drop, good))
						hauler.full = false
					else
						-- Свободный и пустой ждёт работы от диспетчера.
						continue
					end
				end
				if hauler.full then
					local back = hauler.to ~= NONE and hauler.to == hauler.from and returnsTo(w, hauler.to, hauler.resource)
					if hauler.to == NONE or not (back or logistics.accepts(w, player, hauler.to, hauler.resource)) then
						if retry or hauler.to ~= NONE then
							table.insert(homeless, truck)
						end
						hauler.to = NONE
						continue
					end
				elseif not logistics.offersPickup(w, player, hauler.from, hauler.resource) then
					-- Брать нечего. Шахта ещё добывает — ждёт у неё; иначе везёт набранное или бросает работу.
					local mining = hauler.from == hauler.mine and not isSpent(w, hauler.from)
					if not mining then
						if goods.amount(cargo, hauler.resource) > EPSILON then
							hauler.full = true
						else
							table.insert(dropped, truck)
						end
						continue
					end
				end
				local building = if hauler.full then hauler.to else hauler.from
				local toBuilding = hauler.full
				if not (if toBuilding then reaches(w, truck, building) else reaches(w, building, truck)) then
					if seekDue(ctx, truck, hauler) then
						table.insert(seeking, { truck = truck, building = building, toBuilding = toBuilding })
					end
					hauler.waiting = true
					continue
				end
				hauler.waiting = false
				table.insert(working, truck)
			end

			for _, truck in released do
				release(w, truck)
			end
			for _, truck in dropped do
				dropJob(w, truck)
			end
			for _, truck in working do
				local hauler = w:get(truck, "Hauler")
				local cargo = w:get(truck, "Inventory")
				local good = hauler.resource
				if hauler.full then
					hauler.loading = transfer(w, truck, hauler.to, good) > 0
					if goods.amount(cargo, good) <= EPSILON then
						-- Доли копятся с погрешностью: пустой кузов — ровно пустой.
						cargo.items[good] = nil
						dropJob(w, truck)
					elseif goods.room(w:get(hauler.to, "Inventory"), good) <= EPSILON then
						-- Места больше нет — остаток повезёт в другое хранилище.
						table.insert(homeless, truck)
					end
					continue
				end
				local want = hauler.amount - goods.amount(cargo, good)
				hauler.loading = transfer(w, hauler.from, truck, good, want) > 0
				if goods.amount(cargo, good) >= hauler.amount - EPSILON or goods.room(cargo, good) <= EPSILON then
					hauler.full = true
					if hauler.to == NONE then
						table.insert(homeless, truck)
					end
				elseif hauler.from == hauler.mine and isSpent(w, hauler.from) then
					-- Шахта выработана: довозит набранное и освобождается.
					release(w, truck)
				end
			end

			for _, truck in homeless do
				local hauler = w:get(truck, "Hauler")
				local good = carriedBy(w, truck)
				if not good then
					dropJob(w, truck)
					continue
				end
				-- Хранилища полны — груз остаётся в кузове, грузовик пробует снова.
				hauler.resource, hauler.full, hauler.waiting = good, true, false
				local from = hauler.from
				local player = world.ownerOf(w, truck)
				-- Взятое из хранилища и ставшее ненужным едет обратно туда же.
				if from ~= NONE and logistics.isStore(w, from) and not logistics.unreachable(w, from) and logistics.accepts(w, player, from, good) then
					hauler.to = from
					continue
				end
				local other = logistics.deliveryFor(w, truck, good, if from ~= NONE then from else nil)
				local to = other or logistics.deliveryFor(w, truck, good)
				if not to then
					to = requesterFor(w, truck, good)
				end
				if not to and from ~= NONE and not logistics.unreachable(w, from) and returnsTo(w, from, good) then
					to = from
				end
				hauler.to = to or NONE
				-- Места нет только там, куда не подъехать, — груз ложится на землю, как у бросившего работу (abandon).
				-- Просто полные хранилища — другое дело: груз ждёт в кузове, пока место не освободится.
				if not to and not hauler.trapped and blockedTaker(w, player, good) then
					unload(w, truck)
				end
			end

			runRoutes(ctx, w)
			runCarry(ctx, w)
			-- Пустые дропы исчезают.
			drops.sweep(w)
			if ctx.tick % d.dispatchTicks == 0 then
				dispatch(w)
			end
			for _, job in seeking do
				seek(w, job.truck, job.building, job.toBuilding)
			end
			w:flush()
		end,
	},
}

-- По сети (crates/net, rules.rs): склад, работа грузовиков и заявки — только хозяину; склад ящика с грузом виден
-- всем — это не тайна хозяина.
mechanic.net = {
	Inventory = { to = "owner", public = { "Drop" } },
	Hauler = "owner",
	Unreachable = "owner",
	Wanted = "owner",
}

return mechanic
