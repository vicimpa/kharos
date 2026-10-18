--!strict
-- Исследования. Их ведут лаборатории, а план и прогресс — у игрока: все его лаборатории работают над одной темой, и их
-- скорость складывается. Цену темы платят по ходу работы: за каждую долю — ту же долю кредитов со счёта и сырья — со
-- склада лаборатории и складов её сети. Чего в её сети нет, без того она стоит. При нехватке энергии лаборатория
-- работает медленнее, выключенная стоит. Брошенная тема помнит свой прогресс.
--
-- План не встаёт на теме без сырья: если головной теме stallSeconds не из чего работать, лаборатории берутся за
-- следующую открытую тему плана, у которой сырьё под рукой. Темы-открытия открываются сами: достроена лаборатория,
-- найдено месторождение (увидел его или поставил шахту), появился первый готовый ресурс.

local research = require("lib/research")
local goods = require("lib/goods")
local logistics = require("lib/logistics")
local economy = require("lib/economy")
local wallet = require("lib/wallet")
local kinds = require("lib/kinds")

local mechanic = {}

-- Кусок панели игрока (ui/hud).
mechanic.panel = require("./panel")

-- Копия списка: таблицы из ctx:get защищены, table.clone их не берёт.
local function copy(list: { any }): { any }
	local result = {}
	for i, value in list do
		result[i] = value
	end
	return result
end

local EPSILON = 1e-9

mechanic.data = {
	-- Сколько секунд головная тема стоит без сырья, прежде чем лаборатории возьмутся за следующую, и как часто это
	-- сверяется.
	stallSeconds = 10,
	pickSeconds = 1,
}

mechanic.components = {
	-- Лаборатория: на какую долю полной скорости она работает и почему стоит ("idle", "off", "power", "credits" или груз).
	Research = { speed = 0, lack = "" },
}

-- Снаряжение вида: лаборатория сообщает, как идёт работа.
function mechanic.equip(kind, entity)
	if kind.data.researches then
		entity.Research = {}
	end
end

-- Простой головной темы игрока: head — о какой теме, since — с какого тика без сырья (-1 — сырьё есть), checked — когда
-- сверяли. По миру (ctx.storage); не сохраняется.
local stalls = setmetatable({}, { __mode = "k" }) :: { [any]: { [number]: { head: string, since: number, checked: number } } }

-- Сеть лаборатории: что отдают её склады и забрать из них, сначала из хранилищ.
local function networkSources(w, lab: number): { number }
	local network = logistics.networkOf(w, lab)
	return if network then network.members else {}
end

local function networkStock(w, lab: number, good: string): number
	local amount = 0
	for _, source in networkSources(w, lab) do
		if source ~= lab and table.find(logistics.offers(w, source), good) then
			amount += logistics.given(w, source, good)
		end
	end
	return amount
end

local function takeFromNetwork(w, lab: number, needs: { [string]: number })
	local sources = copy(networkSources(w, lab))
	table.sort(sources, function(a, b)
		local one, two = logistics.isStore(w, a), logistics.isStore(w, b)
		if one ~= two then
			return one
		end
		return a < b
	end)
	for good, amount in needs do
		local left = amount
		for _, source in sources do
			if left <= EPSILON then
				break
			end
			if source == lab or not table.find(logistics.offers(w, source), good) then
				continue
			end
			local stock = w:get(source, "Inventory")
			left -= goods.take(stock, good, math.min(left, logistics.given(w, source, good)))
		end
	end
end

-- Есть ли хоть у одной лаборатории всё сырьё темы под рукой (supplied).
local function supplied(w, name: string, labs: { number }): boolean
	local materials = research.price(w, name).materials
	if next(materials) == nil then
		return true
	end
	for _, lab in labs do
		local stock = w:get(lab, "Inventory")
		local all = true
		for good in materials do
			if (if stock then goods.amount(stock, good) else 0) + networkStock(w, lab, good) <= EPSILON then
				all = false
			end
		end
		if all then
			return true
		end
	end
	return false
end

-- Выбирает тему, которую ведут лаборатории игрока: головная уступает, только простояв без сырья.
local function pick(w, player: number, state): string?
	local open = research.open(w, player)
	local head = open[1]
	local byPlayer = stalls[w.storage]
	if not byPlayer then
		byPlayer = {}
		stalls[w.storage] = byPlayer
	end
	if not head then
		byPlayer[player] = nil
		state.topic = ""
		return nil
	end
	local d = mechanic.data
	local tick, step = w.tick, w.dt
	local last = byPlayer[player]
	local same = last ~= nil and last.head == head
	if same and tick >= last.checked and (tick - last.checked) * step < d.pickSeconds then
		return research.current(w, player)
	end
	local labs = {}
	for _, e in w:each({ "Building", "Owner" }) do
		if research.isLab(w, player, e) and not economy.switchedOff(w, e) then
			table.insert(labs, e)
		end
	end
	local since = -1
	if not supplied(w, head, labs) then
		since = if same and last.since >= 0 and last.since <= tick then last.since else tick
	end
	byPlayer[player] = { head = head, since = since, checked = tick }
	local chosen = ""
	if since >= 0 and (tick - since) * step >= d.stallSeconds then
		for i = 2, #open do
			if supplied(w, open[i], labs) then
				chosen = open[i]
				break
			end
		end
	end
	state.topic = chosen
	return if chosen ~= "" then chosen else head
end

-- Виды месторождений, которые игрок нашёл: видит сейчас или поставил на них шахту.
local function depositsFound(w, player: number): { [string]: boolean }
	local found = {}
	for _, e in w:each({ "Deposit", "Position" }) do
		local at = w:get(e, "Position")
		if w:sees(player, at.x, at.y) then
			local kind = kinds.of(w, e)
			if kind then
				found[kind.name] = true
			end
		end
	end
	for _, e in w:each({ "Building", "Owner" }) do
		local kind = kinds.of(w, e)
		if kind and kind.data.extract and w:get(e, "Owner").player == player then
			local deposit = logistics.depositUnder(w, e)
			local spot = deposit and kinds.of(w, deposit)
			if spot then
				found[spot.name] = true
			end
		end
	end
	return found
end

-- Есть ли у игрока готовый ресурс в хранилище или переработке.
local function hasRefined(w, player: number): boolean
	for _, e in w:each({ "Building", "Inventory", "Owner" }) do
		local kind = kinds.of(w, e)
		if kind and (kind.data.stores or kind.data.refines) and w:get(e, "Owner").player == player then
			for good, amount in w:get(e, "Inventory").items do
				local spec = w.protos.goods[good]
				if amount > 0 and spec and spec.data.kind == "resource" then
					return true
				end
			end
		end
	end
	return false
end

-- Ставит лаборатории её состояние, если оно изменилось.
local function report(w, lab: number, speed: number, lack: string)
	local rounded = math.round(speed * 100) / 100
	local current = w:get(lab, "Research")
	if not current then
		w:add(lab, "Research", { speed = rounded, lack = lack })
	elseif current.speed ~= rounded or current.lack ~= lack then
		w:set(lab, "Research", { speed = rounded, lack = lack })
	end
end

-- Первая тема плана, которую можно вести: открытые уже и без открытых предшественников план сбрасывает.
local function nextTopic(w, state): string?
	local plan, known = state.plan, state.research
	local skip = 0
	while skip < #plan do
		local name = plan[skip + 1]
		local kind = research.topic(w, name)
		local ready = kind ~= nil and not table.find(known, name)
		if ready then
			for _, before in kind.data.after or {} do
				if not table.find(known, before) then
					ready = false
				end
			end
		end
		if ready then
			break
		end
		skip += 1
	end
	if skip > 0 then
		state.plan = table.move(plan, skip + 1, #plan, 1, {})
	end
	return state.plan[1]
end

mechanic.systems = {
	-- Раз в секунду: темы-открытия, у которых случилось условие, открываются сами.
	triggers = {
		every = 20,
		run = function(_, ctx)
			for _, e in ctx:each({ "Player" }) do
				local state = ctx:get(e, "Player")
				if state.id == 0 then
					continue
				end
				local known = state.research or {}
				local learned = {}
				local found = nil
				for _, kind in research.list(ctx) do
					local trigger = kind.data.trigger
					if not trigger or table.find(known, kind.name) then
						continue
					end
					local happened
					if trigger == "lab" then
						happened = false
						for _, lab in ctx:each({ "Building", "Owner" }) do
							if research.isLab(ctx, state.id, lab) then
								happened = true
								break
							end
						end
					elseif trigger == "refined" then
						happened = hasRefined(ctx, state.id)
					else
						found = found or depositsFound(ctx, state.id)
						happened = if trigger == "deposit" then next(found :: any) ~= nil else (found :: any)[trigger] == true
					end
					if happened then
						table.insert(learned, kind.name)
					end
				end
				if #learned > 0 then
					local list = copy(known)
					for _, name in learned do
						table.insert(list, name)
						ctx:signal("researched", { player = state.id, topic = name })
					end
					ctx:set(e, "Player", { research = list })
				end
			end
		end,
	},

	-- Лаборатории ведут нынешнюю тему своего хозяина и платят за сделанное.
	research = {
		after = { "assemble" },
		before = { "plan" },
		run = function(_, ctx)
			local labs: { [number]: { number } } = {}
			local any = false
			for _, e in ctx:each({ "Building", "Owner" }) do
				local kind = kinds.of(ctx, e)
				if kind and kind.data.researches and not ctx:has(e, "Site") then
					local player = ctx:get(e, "Owner").player
					labs[player] = labs[player] or {}
					table.insert(labs[player], e)
					any = true
				end
			end
			if not any then
				return
			end
			local w = goods.book(ctx, { "Inventory" })
			local purse = wallet.purse(ctx)
			for player, list in labs do
				local state, entity = research.player(ctx, player)
				if not state then
					continue
				end
				state.plan = state.plan or {}
				state.research = state.research or {}
				state.progress = state.progress or {}
				local topic = if nextTopic(ctx, state) then pick(w, player, state) else nil
				if not topic then
					state.topic = ""
					for _, lab in list do
						report(ctx, lab, 0, "idle")
					end
					ctx:set(entity, "Player", { plan = state.plan, topic = state.topic })
					continue
				end
				local price = research.price(ctx, topic)
				local ticks = math.max(1, price.seconds / ctx.dt)
				local done = state.progress[topic] or 0
				for _, lab in list do
					if economy.switchedOff(ctx, lab) then
						report(ctx, lab, 0, "off")
						continue
					end
					local power = economy.supply(ctx)[lab] or 0
					local share = math.min(power / ticks, 1 - done)
					if share <= EPSILON then
						report(ctx, lab, 0, if power > 0 then "idle" else "power")
						continue
					end
					-- Какую долю своей работы лаборатория может оплатить: всю или сколько хватает самого скудного.
					local part = 1
					local lack = if power < 1 then "power" else ""
					local money = wallet.balance(purse, player) + (purse.players[player] and purse.players[player].earned or 0)
					local cost = price.cost * share
					if cost > EPSILON and money < cost then
						part = math.max(0, money / cost)
						lack = "credits"
					end
					local needs = {}
					local stock = w:get(lab, "Inventory")
					for good, amount in price.materials do
						local need = amount * share
						local have = (if stock then goods.amount(stock, good) else 0) + networkStock(w, lab, good)
						if have + EPSILON < need * part then
							part = math.max(0, have / need)
							lack = good
						end
						needs[good] = need
					end
					if part <= EPSILON then
						report(ctx, lab, 0, if lack ~= "" then lack else "credits")
						continue
					end
					for good in needs do
						needs[good] *= part
					end
					if cost > EPSILON and not wallet.spend(purse, player, math.min(cost * part, money)) then
						report(ctx, lab, 0, "credits")
						continue
					end
					if stock then
						for good in needs do
							needs[good] -= goods.take(stock, good, needs[good])
						end
					end
					takeFromNetwork(w, lab, needs)
					done += share * part
					report(ctx, lab, power * part, lack)
				end
				-- Законченная тема переходит в открытые и уходит из плана.
				if done < 1 - EPSILON then
					state.progress[topic] = done
				else
					state.progress[topic] = nil
					table.insert(state.research, topic)
					local plan = {}
					for _, name in state.plan do
						if name ~= topic then
							table.insert(plan, name)
						end
					end
					state.plan = plan
					state.topic = ""
					ctx:signal("researched", { player = player, topic = topic })
				end
				ctx:set(entity, "Player", { plan = state.plan, research = state.research, progress = state.progress, topic = state.topic })
			end
			wallet.flush(purse)
			w:flush()
		end,
	},
}

-- Состояние игрока и его сущность для приказов плана.
local function stateOf(ctx, player: number)
	local state, entity = research.player(ctx, player)
	if not state then
		return nil, nil
	end
	state.plan = state.plan or {}
	state.research = state.research or {}
	return state, entity
end

mechanic.commands = {
	-- { topic, front } — поставить тему в план вместе с неоткрытыми предшественниками: в конец, front — в начало. Тему,
	-- которой не хватает неслучившегося открытия, в план не поставить.
	research = function(ctx, player, args)
		local state, entity = stateOf(ctx, player)
		if not state or type(args.topic) ~= "string" or not research.topic(ctx, args.topic) then
			return
		end
		local path = research.pathTo(ctx, args.topic, state.research)
		if #path == 0 then
			return
		end
		for _, name in path do
			if research.isTrigger(ctx, name) then
				return
			end
		end
		local plan = {}
		if args.front then
			for _, name in path do
				table.insert(plan, name)
			end
			for _, name in state.plan do
				if not table.find(path, name) then
					table.insert(plan, name)
				end
			end
		else
			plan = copy(state.plan)
			for _, name in path do
				if not table.find(plan, name) then
					table.insert(plan, name)
				end
			end
		end
		ctx:set(entity, "Player", { plan = plan })
	end,

	-- { topic } — убрать тему из плана вместе с темами плана, которым она нужна.
	dequeue = function(ctx, player, args)
		local state, entity = stateOf(ctx, player)
		if not state or type(args.topic) ~= "string" or not research.topic(ctx, args.topic) then
			return
		end
		local plan = {}
		for _, name in state.plan do
			if name ~= args.topic and not (research.topic(ctx, name) and research.under(ctx, name)[args.topic]) then
				table.insert(plan, name)
			end
		end
		ctx:set(entity, "Player", { plan = plan })
	end,

	-- {} — очистить план: начатые темы помнят свой прогресс.
	cancelResearch = function(ctx, player)
		local _, entity = stateOf(ctx, player)
		if entity then
			ctx:set(entity, "Player", { plan = {}, topic = "" })
		end
	end,
}

-- На клиенте: своему игроку — сообщение «Исследовано»; звук — audio/world, один на все темы разом.
mechanic.signals = {
	researched = function(c, signal)
		if signal.player ~= c.player then
			return
		end
		local kind = research.topic(c, signal.topic)
		local list = c.shared.learned or {}
		c.shared.learned = list
		table.insert(list, { topic = signal.topic, time = c.time, trigger = kind and kind.data.trigger ~= nil })
	end,
}

return mechanic
