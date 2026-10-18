--!strict
-- Энергия и доход — перенос busy.ts, income.ts (storeEnergy, earn, wear) и наград economy.ts. Как считается
-- хозяйство сети — lib/economy, общее с клиентом; здесь то, что меняет мир:
-- - метка Busy: у потребителя есть дело — просит всю свою энергию, нет — треть (markBusy);
-- - накопители отдают недостающее и копят излишек (storeEnergy);
-- - доход игрокам и износ перегруженных электростанций (earn);
-- - доля работы турелей зданий (Throttle): без энергии, выключенная или сворачивающаяся — молчит;
-- - награды за то, что игрок сделал впервые (reward), и выключатель потребителей (work).

local economy = require("lib/economy")
local kinds = require("lib/kinds")
local wallet = require("lib/wallet")
local goods = require("lib/goods")
local logistics = require("lib/logistics")

-- Сколько секунд идёт сборка изделия (cycleSeconds): сырьё по ASSEMBLE_RATE в секунду.
local function assemblyCycle(product): number
	local total = 0
	for _, amount in product.data.recipe do
		total += amount
	end
	return total
end

local readf64, writef64 = buffer.readf64, buffer.writef64

local mechanic = {}

mechanic.data = {
	-- Как часто хост решает, кто из потребителей занят, в тиках, и сколько секунд кончивший дело ещё значится
	-- работающим: завод между двумя сборками нагрузку не дёргает (BUSY_TICKS, HOLD).
	busyTicks = 10,
	hold = 2,
	-- Кредиты за то, что игрок сделал впервые (rewards.json): ключи зданий совпадают с их видами.
	rewards = {
		deploy = 250,
		unit = 50,
		generator = 150,
		matter = 200,
		mine = 200,
		metalYard = 50,
		sale = 100,
	},
	-- Что сказать игроку о награде (rewards в ru.json).
	rewardTitles = {
		deploy = "Главное здание развёрнуто",
		unit = "Первый юнит произведён",
		generator = "Первая электростанция",
		matter = "Первый генератор материи",
		mine = "Первая шахта",
		metalYard = "Первый склад металла",
		sale = "Первая продажа",
	},
}

mechanic.components = {
	-- У потребителя есть дело (busy.ts). Кто работает всегда (генератор материи, радар), метки не получает.
	Busy = {},
	-- Игрок выключил потребителя: энергии не просит и не работает.
	Off = {},
	-- Накопитель: заряд и сколько отдаёт в этот тик (больше нуля) или берёт (меньше).
	Accumulator = { charge = 0, flow = 0 },
}

-- Когда каждое здание последний раз видели за работой, в тиках, — по миру (ctx.storage). Не сохраняется: после
-- загрузки набирается заново.
local seen = setmetatable({}, { __mode = "k" }) :: { [any]: { [number]: number } }

-- Турели зданий: носитель → его вооружённые турели.
local function turretsByCarrier(ctx): { [number]: { number } }
	local found = {}
	for _, e in ctx:each({ "Attached", "Armed" }) do
		local parent = ctx:get(e, "Attached").parent
		local list = found[parent]
		if not list then
			list = {}
			found[parent] = list
		end
		table.insert(list, e)
	end
	return found
end

-- Есть ли у готового включённого потребителя дело (working). Механики, которых ещё нет (ракеты, торговля, щиты), дела
-- не дают.
local function working(ctx, e: number, data, turrets): boolean
	-- Лаборатория: ведёт тему или вела бы, будь энергия.
	if data.researches then
		local lab = ctx:get(e, "Research")
		return lab ~= nil and (lab.speed > 0 or lab.lack == "power")
	end
	if data.warhead or data.intercept or data.trades or data.shield then
		return false
	end
	-- Переработка: есть руда и место под готовое.
	if data.refines then
		local stock = ctx:get(e, "Inventory")
		local product = goods.resourceOf(ctx, data.refines)
		return stock ~= nil and goods.amount(stock, data.refines) > 1e-6 and product ~= nil and goods.room(stock, product) > 1e-6
	end
	-- Цех: сборка идёт или её есть из чего начать; готовое, которому некуда лечь, — простой.
	local assembly = ctx:get(e, "Assembly")
	if assembly then
		local product = ctx.protos.goods[assembly.recipe]
		local stock = ctx:get(e, "Inventory")
		if not product or not stock then
			return false
		end
		local room = goods.room(stock, product.name) >= product.data.yield - 1e-9
		if assembly.progress > 0 then
			return assembly.progress < assemblyCycle(product) - 1e-6 or room
		end
		if not room then
			return false
		end
		for good, amount in product.data.recipe do
			if goods.amount(stock, good) < amount - 1e-6 then
				return false
			end
		end
		return true
	end
	-- Производство: заказ начат или его материалы на месте.
	if data.produces then
		local producer = ctx:get(e, "Producer")
		if not producer or producer.unit == "" or ctx:has(e, "Converting") then
			return false
		end
		return producer.progress > 0 or next(logistics.missing(ctx, e)) == nil
	end
	if data.repair then
		local repair = ctx:get(e, "Repair")
		return repair ~= nil and repair.target >= 0
	end
	-- Турель на энергии: есть цель или оружие ещё перезаряжается.
	if data.mounts then
		for _, turret in turrets[e] or {} do
			local armed = ctx:get(turret, "Armed")
			if armed.target >= 0 or armed.cooldown > 0 then
				return true
			end
		end
		return false
	end
	return true
end

mechanic.systems = {
	-- Раз в busyTicks, до энергии: потребители, у которых есть дело, получают метку Busy, оставшиеся без него — теряют.
	-- «Работает» — значит, есть над чем: от энергии это не зависит, иначе метка мигала бы.
	busy = {
		query = { "Building" },
		after = { "convert" },
		before = { "produce" },
		run = function(q, ctx)
			local d = mechanic.data
			if ctx.tick % d.busyTicks ~= 0 then
				return
			end
			local last = seen[ctx.storage]
			if not last then
				last = {}
				seen[ctx.storage] = last
			end
			local hold = d.hold / ctx.dt
			local alive = {}
			local turrets = turretsByCarrier(ctx)
			for i = 0, q.n - 1 do
				local e = readf64(q.entity, i * 8)
				local kind = kinds.of(ctx, e)
				-- Кто работает всегда, тому метка не нужна: хозяйство знает это по виду здания.
				if not kind or (kind.data.power or 0) >= 0 or economy.alwaysBusy(kind.data) then
					continue
				end
				alive[e] = true
				local off = ctx:has(e, "Site") or economy.switchedOff(ctx, e)
				if not off and working(ctx, e, kind.data, turrets) then
					last[e] = ctx.tick
				end
				local since = if off then nil else last[e]
				local busy = since ~= nil and ctx.tick - since < hold
				if busy ~= ctx:has(e, "Busy") then
					if busy then
						ctx:add(e, "Busy")
					else
						ctx:remove(e, "Busy")
					end
				end
			end
			for e in last do
				if not alive[e] then
					last[e] = nil
				end
			end
		end,
	},

	-- До всех потребителей: накопители решают, сколько отдают сети в этот тик и сколько берут. Не хватает выработки —
	-- отдают недостающее, сколько позволяют скорость и заряд; есть излишек — копят его, потребителей не объедая.
	store = {
		query = { "Accumulator" },
		write = { "Accumulator" },
		after = { "busy" },
		before = { "produce" },
		run = function(q, ctx)
			local charge, flow = q.Accumulator.charge, q.Accumulator.flow
			local rows = {}
			for i = 0, q.n - 1 do
				writef64(flow, i * 8, 0)
				rows[readf64(q.entity, i * 8)] = i * 8
			end
			local step = ctx.dt
			if q.n > 0 then
				for _, grid in ctx:grids() do
					local cells = {}
					for _, e in grid.members do
						if rows[e] then
							table.insert(cells, e)
						end
					end
					if #cells == 0 then
						continue
					end
					local book = economy.ofGrid(ctx, grid.members, false)
					local balance = book.produced - book.demand
					for _, e in cells do
						local at = rows[e]
						local battery = kinds.of(ctx, e).data.battery
						local stored = readf64(charge, at)
						local given = 0
						if balance < 0 and stored > 0 then
							given = math.min(battery.rate, -balance, stored / step)
						elseif balance > 0 and stored < battery.capacity then
							given = -math.min(battery.rate, balance, (battery.capacity - stored) / step)
						end
						balance += given
						writef64(flow, at, given)
						writef64(charge, at, math.max(0, math.min(battery.capacity, stored - given * step)))
					end
				end
			end
			-- Хозяйства этого тика считаются заново: накопители уже решили (openBooks).
			economy.reopen()
		end,
	},

	-- Доля работы носителей турелей (Throttle): потребителю — его доля энергии, выключенному, недостроенному и
	-- сворачивающемуся — ноль.
	throttle = {
		query = { "Throttle" },
		write = { "Throttle" },
		after = { "store" },
		before = { "fight" },
		run = function(q, ctx)
			local share = q.Throttle.share
			for i = 0, q.n - 1 do
				local e = readf64(q.entity, i * 8)
				local stopped = ctx:has(e, "Site") or ctx:has(e, "Converting") or economy.switchedOff(ctx, e)
				writef64(share, i * 8, if stopped then 0 else economy.shareOf(ctx, e))
			end
		end,
	},

	-- В конце тика: доход игрокам (доли кредита копятся в earned) и износ перегруженных электростанций — они теряют
	-- прочность и в нуле разрушаются; сами не восстанавливаются, их чинят строители.
	earn = {
		query = { "Player" },
		after = { "recover" },
		run = function(_, ctx)
			local books = economy.books(ctx)
			if #books == 0 then
				return
			end
			local step = ctx.dt
			local incomes = {}
			for _, book in books do
				incomes[book.player] = (incomes[book.player] or 0) + book.economy.income
			end
			local purse = wallet.purse(ctx)
			for player, income in incomes do
				wallet.earn(purse, player, income * step)
			end
			wallet.flush(purse)
			local ruined = {}
			for _, book in books do
				local overload = economy.overloadOf(book.economy)
				if overload <= 0 then
					continue
				end
				for _, e in book.grid.members do
					local kind = kinds.of(ctx, e)
					if not kind or economy.powerAt(ctx, e, kind) <= 0 then
						continue
					end
					local health = ctx:get(e, "Health")
					local value = health.value - economy.OVERLOAD_DAMAGE * overload * step
					if value <= 0 then
						table.insert(ruined, e)
					else
						ctx:set(e, "Health", { value = value })
					end
				end
			end
			-- Сгоревшая с топливом взрывается, как разбитая в бою (meltdown).
			for _, e in ruined do
				local meltdown = ctx:get(e, "Meltdown")
				if meltdown then
					local at = ctx:get(e, "Position")
					ctx:spawn(nil, { Position = { x = at.x, y = at.y }, Burst = { radius = meltdown.radius, damage = meltdown.damage } })
				end
				ctx:destroy(e)
			end
		end,
	},
}

-- Выдаёт игроку награду key, если он её ещё не получал (reward): каждая — раз за игру.
local function reward(ctx, player: number, key: string)
	local credits = mechanic.data.rewards[key]
	local entity = wallet.of(ctx, player)
	if not credits or not entity then
		return
	end
	local state = ctx:get(entity, "Player")
	local got = state.rewards or {}
	if table.find(got, key) then
		return
	end
	table.insert(got, key)
	ctx:set(entity, "Player", { credits = state.credits + credits, rewards = got })
	ctx:signal("reward", { player = player, key = key, credits = credits })
end

mechanic.on = {
	-- { player, key } — что сделал игрок: событий без награды большинство.
	reward = function(ctx, event)
		reward(ctx, event.player, event.key)
	end,
	-- Достроено здание: первое своего вида может принести награду.
	built = function(ctx, event)
		local kind = ctx:alive(event.entity) and kinds.of(ctx, event.entity)
		if kind then
			reward(ctx, event.player, kind.name)
		end
	end,
}

mechanic.commands = {
	-- { building, on } — включить или выключить своё готовое здание-потребитель (setWorking). Выключенное не просит
	-- энергии и не работает: начатое стоит и продолжится после включения, турели молчат.
	work = function(ctx, player, args)
		local e = args.building
		if type(e) ~= "number" or not ctx:alive(e) or type(args.on) ~= "boolean" then
			return
		end
		local kind = kinds.of(ctx, e)
		local owner = ctx:get(e, "Owner")
		if not kind or not owner or owner.player ~= player or ctx:has(e, "Site") or not ctx:has(e, "Building") or not economy.switchable(kind) then
			return
		end
		-- Новый цех выключен без метки Off: у него свой флаг on, и он главнее.
		local assembly = ctx:get(e, "Assembly")
		if assembly and assembly.on ~= args.on then
			ctx:set(e, "Assembly", { on = args.on })
		end
		if args.on == ctx:has(e, "Off") then
			if args.on then
				ctx:remove(e, "Off")
			else
				ctx:add(e, "Off")
			end
		end
	end,
}

-- На клиенте: награда своему игроку — сообщение на панели (ui/hud); звук — audio/world.
mechanic.signals = {
	reward = function(c, signal)
		if signal.player ~= c.player then
			return
		end
		local toasts = c.shared.rewards or {}
		c.shared.rewards = toasts
		table.insert(toasts, { title = mechanic.data.rewardTitles[signal.key] or signal.key, credits = signal.credits, time = c.time })
	end,
}

return mechanic
