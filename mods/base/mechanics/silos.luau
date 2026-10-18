--!strict
-- Ядерный удар. Ракетная шахта (data.warhead) собирает боеголовку, как лаборатория тему: цена — кредиты и готовое из
-- сети шахты — списывается сразу, сборка идёт при полной энергии warhead.seconds секунд, при нехватке медленнее, в
-- выключенной шахте стоит. Боеголовка одна за раз. Готовую игрок наводит на любую точку карты: через launch секунд
-- после приказа ракета стартует — до этого пуск можно отменить, — и шахта снова пуста. Шахта с готовой боеголовкой,
-- разбитая, взрывается, как реактор (Meltdown).
--
-- Ракета летит по прямой speed тайлов в секунду; её весь полёт видят все игроки. Со старта место пуска на launchMark
-- секунд отмечено у всех, у кого есть готовый радар (Mark launch). Точку удара весь полёт видят те, чьи здания или
-- юниты в радиусе взрыва (Mark strike): список сверяется раз в watch секунд. Взрыв — Burst движка: бьёт всех без
-- разбора, щит его не держит. Вспышка взрыва на glare секунд открывает его круг всем игрокам — глазами Flash
-- (mechanics/radar), по одному на игрока.
--
-- Защита — перехватчик (data.intercept). Ракеты-перехватчики он собирает сам, по одной, пока включён и их меньше
-- ёмкости. Каждой сбивает одну чужую ракету (не свою и не союзника), чья точка удара в его круге, когда та в этот
-- круг входит: решено сразу, а ракета-перехватчик (Chaser) летит к точке встречи на курсе и успевает всегда.

local economy = require("lib/economy")
local goods = require("lib/goods")
local kinds = require("lib/kinds")
local logistics = require("lib/logistics")
local missilesLib = require("lib/missiles")
local tactics = require("lib/tactics")
local wallet = require("lib/wallet")
local world = require("lib/world")

local readf64 = buffer.readf64

local mechanic = {}

mechanic.data = {
	-- Сколько секунд место пуска отмечено у игроков с радаром; раз во сколько секунд сверяется, чьё под ударом; сколько
	-- секунд вспышка взрыва открывает всем его круг.
	launchMark = 60,
	watch = 1,
	glare = 5,
	-- Размер вспышки сбитой ракеты, в тайлах: картинка, урона нет.
	airburst = 1.5,
}

mechanic.components = {
	-- Шахта: ticks — срок сборки при полной энергии, progress — собрано, cost — списано кредитов (отмена вернёт); ticks
	-- ноль — сборки нет. ready — боеголовка готова. start — тик приказа о пуске, −1 — пуск не идёт; toX, toY — цель.
	Silo = { progress = 0, ticks = 0, cost = 0, ready = false, start = -1, toX = 0, toY = 0 },
	-- Перехватчик: сборка ракеты, как у шахты; missiles — сколько готовых ждут чужую ядерную.
	Interceptor = { progress = 0, ticks = 0, missiles = 0 },
	-- Ядерная ракета в полёте: откуда, куда, с какого тика, где сейчас, чья; mark — метка точки удара, hunted — тик,
	-- когда её собьёт уже выпущенный перехватчик, −1 — по ней не стреляли.
	Missile = { fromX = 0, fromY = 0, toX = 0, toY = 0, born = 0, x = 0, y = 0, player = 0, mark = -1, hunted = -1 },
	-- Ракета-перехватчик: летит из (fromX, fromY) с тика born и встречает ракету missile над (toX, toY) на высоте lift
	-- в тик arrive.
	Chaser = { fromX = 0, fromY = 0, toX = 0, toY = 0, lift = 0, born = 0, arrive = 0, player = 0, missile = -1 },
	-- Метка на карте до тика until: место пуска (launch) или точка удара (strike); viewers — кому видна.
	Mark = { kind = "", ["until"] = 0, player = 0, viewers = {} },
}

-- На какой высоте ракета (lib/missiles).
mechanic.lift = missilesLib.lift

local function warheadOf(w, e: number)
	local kind = kinds.of(w, e)
	return kind and kind.data.warhead
end

-- Своя готовая шахта игрока: её состояние и боеголовка вида.
local function ownSilo(ctx, player: number, silo: any)
	if type(silo) ~= "number" or not ctx:alive(silo) then
		return nil, nil
	end
	local warhead = warheadOf(ctx, silo)
	local state = ctx:get(silo, "Silo")
	if not warhead or not state or not world.isReady(ctx, player, silo) then
		return nil, nil
	end
	return state, warhead
end

-- Что мешает начать сборку боеголовки: "busy", "credits", "materials"; nil — ничего.
function mechanic.warheadLack(w, player: number, silo: number): string?
	local warhead = warheadOf(w, silo)
	local state = w:get(silo, "Silo")
	if not warhead or not state or not world.isReady(w, player, silo) or state.ticks > 0 or state.ready then
		return "busy"
	end
	if wallet.credits(w, player) < warhead.cost then
		return "credits"
	end
	return if logistics.networkHas(w, silo, warhead.materials) then nil else "materials"
end

-- Что мешает перехватчику начать сборку следующей ракеты: "off", "credits", "materials"; nil — ничего, он уже собирает
-- или полон.
function mechanic.interceptorLack(w, e: number): string?
	local kind = kinds.of(w, e)
	local spec = kind and kind.data.intercept
	local state = w:get(e, "Interceptor")
	if not spec or not state or state.ticks > 0 or state.missiles >= spec.capacity then
		return nil
	end
	if w:has(e, "Off") then
		return "off"
	end
	local owner = w:get(e, "Owner")
	if wallet.credits(w, if owner then owner.player else 0) < spec.cost then
		return "credits"
	end
	return if logistics.networkHas(w, e, spec.materials) then nil else "materials"
end

mechanic.commands = {
	-- { silo } — начать сборку боеголовки в своей пустой шахте: кредиты и готовое списываются сразу.
	warhead = function(ctx, player, args)
		local state, warhead = ownSilo(ctx, player, args.silo)
		if not state or mechanic.warheadLack(ctx, player, args.silo) or not wallet.pay(ctx, player, warhead.cost) then
			return
		end
		local w = goods.book(ctx, { "Inventory" })
		logistics.takeFromNetwork(w, args.silo, warhead.materials)
		w:flush()
		ctx:set(args.silo, "Silo", { progress = 0, ticks = math.floor(warhead.seconds / ctx.dt + 0.5), cost = warhead.cost })
	end,

	-- { silo } — бросить сборку: цена возвращается целиком, вложенное время пропадает.
	cancelWarhead = function(ctx, player, args)
		local state, warhead = ownSilo(ctx, player, args.silo)
		if not state or state.ticks <= 0 or state.ready then
			return
		end
		wallet.refund(ctx, player, state.cost)
		local w = goods.book(ctx, { "Inventory" })
		logistics.returnToNetwork(w, args.silo, warhead.materials)
		w:flush()
		ctx:set(args.silo, "Silo", { progress = 0, ticks = 0, cost = 0 })
	end,

	-- { silo, x, y } — пуск готовой боеголовки в тайл (x, y): ракета стартует через warhead.launch секунд; наведённую
	-- можно навести заново, пока она не стартовала.
	launch = function(ctx, player, args)
		local state = ownSilo(ctx, player, args.silo)
		local x, y = args.x, args.y
		if not state or not state.ready or type(x) ~= "number" or type(y) ~= "number" then
			return
		end
		x, y = math.floor(x), math.floor(y)
		if not world.inBounds(ctx, x, y) then
			return
		end
		ctx:set(args.silo, "Silo", { start = if state.start < 0 then ctx.tick else state.start, toX = x + 0.5, toY = y + 0.5 })
		if state.start < 0 then
			ctx:signal("launching", { player = player, silo = args.silo })
		end
	end,

	-- { silo } — отменить пуск, пока ракета не стартовала: боеголовка остаётся в шахте.
	abortLaunch = function(ctx, player, args)
		local state = ownSilo(ctx, player, args.silo)
		if state and state.start >= 0 then
			ctx:set(args.silo, "Silo", { start = -1 })
		end
	end,
}

-- Игроки, у которых есть готовый радар: им видно место пуска.
local function radarOwners(ctx): { number }
	local players, list = {}, {}
	for _, e in ctx:each({ "Building", "Owner" }) do
		local kind = kinds.of(ctx, e)
		local owner = ctx:get(e, "Owner").player
		if kind and kind.data.scan and not ctx:has(e, "Site") and owner ~= 0 and not players[owner] then
			players[owner] = true
			table.insert(list, owner)
		end
	end
	return list
end

-- Игроки, чьи здания или юниты не дальше radius от точки (x, y), кроме except.
local function playersNear(ctx, x: number, y: number, radius: number, except: number): { number }
	local players, list = {}, {}
	local all = ctx:query({ "Owner", "Position" })
	for i = 0, all.n - 1 do
		local at = i * 8
		local player = readf64(all.Owner.player, at)
		if player == 0 or player == except or players[player] then
			continue
		end
		local e = readf64(all.entity, at)
		local size = ctx:get(e, "Building")
		local width, height = if size then size.width else 0, if size then size.height else 0
		local left, top = readf64(all.Position.x, at) - width / 2, readf64(all.Position.y, at) - height / 2
		local dx = math.max(left - x, 0, x - left - width)
		local dy = math.max(top - y, 0, y - top - height)
		if math.sqrt(dx * dx + dy * dy) <= radius then
			players[player] = true
			table.insert(list, player)
		end
	end
	return list
end

-- Через сколько тиков ракета-перехватчик со скоростью speed из (x, y) встретит ядерную ракету: не успевает — встреча в
-- последний тик до удара: перехват уже решён. Ноль — сбить сразу.
local function meetTicks(ctx, missile, x: number, y: number, speed: number, warheadSpeed: number): number
	local flight = warheadSpeed * ctx.dt
	local reach = math.sqrt((missile.toX - missile.x) ^ 2 + (missile.toY - missile.y) ^ 2)
	local last = math.ceil(reach / flight) - 1
	for k = 1, last - 1 do
		local flown = math.min(reach, flight * k) / (if reach > 0 then reach else 1)
		local meetX = missile.x + (missile.toX - missile.x) * flown
		local meetY = missile.y + (missile.toY - missile.y) * flown
		if math.sqrt((meetX - x) ^ 2 + (meetY - y) ^ 2) <= speed * ctx.dt * k then
			return k
		end
	end
	return math.max(0, last)
end

mechanic.systems = {
	-- До боя: шахты собирают боеголовки и пускают ракеты, перехватчики собирают свои и стреляют, ракеты летят и рвутся
	-- — их взрыв бьёт в этот же бой, — или гибнут от перехватчика; метки, чей срок вышел, пропадают.
	missiles = {
		query = { "Silo", "Building", "Position", "Owner" },
		after = { "supply" },
		before = { "fight" },
		run = function(q, ctx)
			local d = mechanic.data
			local supply: { [number]: number }? = nil
			local function power(): { [number]: number }
				supply = supply or economy.supply(ctx)
				return supply :: any
			end
			local tick, dt = ctx.tick, ctx.dt
			local fired = {}
			local warheadSpec = nil
			for i = 0, q.n - 1 do
				local at = i * 8
				local silo = readf64(q.entity, at)
				local warhead = warheadOf(ctx, silo)
				if not warhead then
					continue
				end
				warheadSpec = warhead
				local state = ctx:get(silo, "Silo")
				local ready = state.ready
				if state.ticks > 0 and not state.ready and not ctx:has(silo, "Off") and not ctx:has(silo, "Site") then
					-- Энергии не хватает — сборка идёт медленнее.
					local progress = state.progress + (power()[silo] or 0)
					if progress >= state.ticks then
						ctx:set(silo, "Silo", { progress = 0, ticks = 0, cost = 0, ready = true })
						ready = true
						ctx:signal("warheadReady", { player = readf64(q.Owner.player, at) })
					else
						ctx:set(silo, "Silo", { progress = progress })
					end
				end
				-- С готовой боеголовкой разбитая шахта рвётся, как реактор.
				local meltdown = ready and kinds.of(ctx, silo).data.meltdown
				if (meltdown ~= nil and meltdown ~= false) ~= ctx:has(silo, "Meltdown") then
					if meltdown then
						ctx:add(silo, "Meltdown", { radius = meltdown.radius, damage = meltdown.damage })
					else
						ctx:remove(silo, "Meltdown")
					end
				end
				if state.start < 0 or tick - state.start < math.floor(warhead.launch / dt + 0.5) then
					continue
				end
				table.insert(fired, { silo = silo, player = readf64(q.Owner.player, at), x = readf64(q.Position.x, at), y = readf64(q.Position.y, at), toX = state.toX, toY = state.toY, warhead = warhead })
			end
			warheadSpec = warheadSpec or ctx.protos.buildings.silo.data.warhead
			local speed, blast = warheadSpec.speed, warheadSpec.blast

			-- Перехватчики: собирают ракеты на долю энергии, с ракетами — стреляют.
			local armed = {}
			for _, e in ctx:each({ "Interceptor", "Building", "Position", "Owner" }) do
				local kind = kinds.of(ctx, e)
				local spec = kind and kind.data.intercept
				if not spec or ctx:has(e, "Site") or ctx:has(e, "Off") then
					continue
				end
				local state = ctx:get(e, "Interceptor")
				local player = ctx:get(e, "Owner").player
				local missiles = state.missiles
				if state.ticks > 0 then
					local progress = state.progress + (power()[e] or 0)
					if progress >= state.ticks then
						missiles += 1
						ctx:set(e, "Interceptor", { progress = 0, ticks = 0, missiles = missiles })
					else
						ctx:set(e, "Interceptor", { progress = progress })
					end
				elseif not mechanic.interceptorLack(ctx, e) and missiles < spec.capacity and wallet.pay(ctx, player, spec.cost) then
					local w = goods.book(ctx, { "Inventory" })
					logistics.takeFromNetwork(w, e, spec.materials)
					w:flush()
					ctx:set(e, "Interceptor", { progress = 0, ticks = math.floor(spec.seconds / dt + 0.5) })
				end
				if missiles > 0 then
					local at = ctx:get(e, "Position")
					table.insert(armed, { entity = e, player = player, x = at.x, y = at.y, radius = spec.radius, speed = spec.speed, missiles = missiles })
				end
			end
			-- Кого сбивают: изменения мира — после системы, а сбитую сразу (k = 0) надо убрать в этот же тик.
			local hunted: { [number]: number } = {}
			for _, entity in ctx:each({ "Missile" }) do
				local missile = ctx:get(entity, "Missile")
				if missile.hunted >= 0 or #armed == 0 then
					continue
				end
				local best, bestReach = nil, math.huge
				for _, guard in armed do
					if guard.missiles <= 0 or guard.player == missile.player or tactics.allied(ctx, guard.player, missile.player) then
						continue
					end
					local reach = math.sqrt((missile.x - guard.x) ^ 2 + (missile.y - guard.y) ^ 2)
					if reach > guard.radius or reach >= bestReach or math.sqrt((missile.toX - guard.x) ^ 2 + (missile.toY - guard.y) ^ 2) > guard.radius then
						continue
					end
					best, bestReach = guard, reach
				end
				if not best then
					continue
				end
				best.missiles -= 1
				ctx:set(best.entity, "Interceptor", { missiles = best.missiles })
				local k = meetTicks(ctx, missile, best.x, best.y, best.speed, speed)
				ctx:set(entity, "Missile", { hunted = tick + k })
				hunted[entity] = tick + k
				if k == 0 then
					continue
				end
				local reach = math.sqrt((missile.toX - missile.x) ^ 2 + (missile.toY - missile.y) ^ 2)
				reach = if reach > 0 then reach else 1
				local ahead = math.min(reach, speed * dt * k)
				ctx:signal("intercept", { x = best.x, y = best.y })
				ctx:spawn(nil, { Chaser = {
					fromX = best.x,
					fromY = best.y,
					toX = missile.x + (missile.toX - missile.x) * ahead / reach,
					toY = missile.y + (missile.toY - missile.y) * ahead / reach,
					lift = mechanic.lift((tick + k - missile.born) * dt, reach - ahead, speed),
					born = tick,
					arrive = tick + k,
					player = best.player,
					missile = entity,
				} })
			end

			-- Ракеты летят; сбитая гибнет в воздухе вспышкой без урона, долетевшая рвётся.
			local players = {}
			for _, e in ctx:each({ "Player" }) do
				table.insert(players, ctx:get(e, "Player").id)
			end
			local watch = math.max(1, math.floor(d.watch / dt + 0.5))
			for _, entity in ctx:each({ "Missile" }) do
				local missile = ctx:get(entity, "Missile")
				missile.hunted = hunted[entity] or missile.hunted
				if missile.hunted >= 0 and tick >= missile.hunted then
					if missile.mark >= 0 and ctx:alive(missile.mark) then
						ctx:destroy(missile.mark)
					end
					local lift = mechanic.lift((tick - missile.born) * dt, math.sqrt((missile.toX - missile.x) ^ 2 + (missile.toY - missile.y) ^ 2), speed)
					ctx:spawn(nil, { Position = { x = missile.x, y = missile.y }, Blast = { size = d.airburst, lift = lift, life = math.floor((0.25 + d.airburst * 0.2) / dt + 0.5) } })
					ctx:destroy(entity)
					continue
				end
				local reach = math.sqrt((missile.toX - missile.x) ^ 2 + (missile.toY - missile.y) ^ 2)
				local step = speed * dt
				if reach <= step then
					if missile.mark >= 0 and ctx:alive(missile.mark) then
						ctx:destroy(missile.mark)
					end
					ctx:spawn(nil, { Position = { x = missile.toX, y = missile.toY }, Burst = { radius = blast.radius, damage = blast.damage, core = blast.core } })
					-- Вспышка открывает круг взрыва всем: глаз на каждого игрока.
					for _, player in players do
						ctx:spawn(nil, { Position = { x = missile.toX, y = missile.toY }, Owner = { player = player }, Sight = { radius = blast.radius }, Flash = { till = tick + math.floor(d.glare / dt + 0.5) } })
					end
					ctx:signal("nuke", { x = missile.toX, y = missile.toY, player = missile.player })
					ctx:destroy(entity)
					continue
				end
				local x = missile.x + (missile.toX - missile.x) / reach * step
				local y = missile.y + (missile.toY - missile.y) / reach * step
				ctx:set(entity, "Missile", { x = x, y = y })
				-- Под удар за время полёта входят и из-под него уходят.
				if (tick - missile.born) % watch == 0 and missile.mark >= 0 and ctx:alive(missile.mark) then
					ctx:set(missile.mark, "Mark", { viewers = playersNear(ctx, missile.toX, missile.toY, blast.radius, missile.player) })
				end
			end

			-- Стартовавшая ракета трогается со следующего тика: в тик born она над шахтой.
			for _, launch in fired do
				ctx:set(launch.silo, "Silo", { ready = false, start = -1 })
				local reach = math.sqrt((launch.toX - launch.x) ^ 2 + (launch.toY - launch.y) ^ 2)
				local flight = math.ceil(reach / (speed * dt))
				-- Точка удара отмечена весь полёт; метку убирает сама ракета, срок — с запасом в тик.
				local mark = ctx:spawn(nil, { Position = { x = launch.toX, y = launch.toY }, Mark = { kind = "strike", ["until"] = tick + flight + 1, player = launch.player, viewers = playersNear(ctx, launch.toX, launch.toY, blast.radius, launch.player) } })
				ctx:spawn(nil, { Missile = { fromX = launch.x, fromY = launch.y, toX = launch.toX, toY = launch.toY, born = tick, x = launch.x, y = launch.y, player = launch.player, mark = mark } })
				local viewers = {}
				for _, player in radarOwners(ctx) do
					if player ~= launch.player then
						table.insert(viewers, player)
					end
				end
				ctx:spawn(nil, { Position = { x = launch.x, y = launch.y }, Mark = { kind = "launch", ["until"] = tick + math.floor(d.launchMark / dt + 0.5), player = launch.player, viewers = viewers } })
				ctx:signal("liftoff", { x = launch.x, y = launch.y, player = launch.player })
			end

			-- Метки и ракеты-перехватчики, чей срок вышел.
			for _, e in ctx:each({ "Mark" }) do
				if tick >= ctx:get(e, "Mark")["until"] then
					ctx:destroy(e)
				end
			end
			for _, e in ctx:each({ "Chaser" }) do
				if tick >= ctx:get(e, "Chaser").arrive then
					ctx:destroy(e)
				end
			end
		end,
	},
}

-- На клиенте: старт ракеты из шахты — рёв, слышный далеко; ракета-перехватчик со станка — тот же рёв, но ближе; ядерный
-- взрыв слышен ещё дальше; своя боеголовка готова — уведомление.
mechanic.signals = {
	liftoff = function(c, signal)
		c:sound("liftoff", { x = signal.x, y = signal.y, volume = 1.1, reach = 3 })
	end,
	intercept = function(c, signal)
		c:sound("liftoff", { x = signal.x, y = signal.y, volume = 1.1 * 0.7, reach = 2 })
	end,
	nuke = function(c, signal)
		c:sound("nukeBlast", { x = signal.x, y = signal.y, volume = 1.6, reach = 6 })
	end,
	warheadReady = function(c, signal)
		if signal.player == c.player then
			c:sound("warheadReady", { volume = 0.4 })
		end
	end,
}

return mechanic
