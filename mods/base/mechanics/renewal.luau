--!strict
-- Смена месторождений. Выработанное месторождение уходит с карты, как только на нём нет шахты (готовой или строящейся,
-- чьей угодно), а через Rules.depositRenewal минут после выработки в случайной пустой клетке карты появляется новое —
-- тем же генератором: вид по биому, запас по виду. Месторождений столько же, сколько было, но лежат они уже не там: за
-- ними приходится идти, и разведка не кончается.
--
-- Туман — дело памяти движка (Memorable): новое месторождение игрок знает, только увидев его место, а ушедшее помнит,
-- пока не увидит, что его нет.

local deposits = require("lib/deposits")
local kinds = require("lib/kinds")

local mechanic = {}

mechanic.data = {
	-- Раз в сколько тиков всё это проверяется: месторождения уходят и появляются за минуты.
	check = 20,
	-- Не ближе скольких тайлов к зданиям и стройкам появляется новое месторождение.
	clearance = 12,
	-- Сколько клеток пробуется за проверку под одно новое; не нашлось — до следующей проверки.
	tries = 24,
	-- Сдвиг сида: места новых не повторяют места генератора.
	salt = 40507,
}

mechanic.components = {
	-- Выработано: смена уже заказана.
	Deposit = { spent = false },
}

-- Сроки смены (тики, по возрастанию) и сколько мест уже пробовали — в ctx.storage.renewal, уходят в сохранение.
local function stateOf(ctx)
	local state = ctx.storage.renewal
	if not state then
		state = { due = {}, spawned = 0 }
		ctx.storage.renewal = state
	end
	return state
end

-- Стоит ли на месторождении шахта — готовая или строящаяся, чья угодно: у шахты то же место, что у него.
local function hasMine(ctx, at): boolean
	for _, e in ctx:each({ "Building", "Position" }) do
		local kind = kinds.of(ctx, e)
		if kind and kind.data.extract then
			local p = ctx:get(e, "Position")
			if p.x == at.x and p.y == at.y then
				return true
			end
		end
	end
	return false
end

-- Номера игроков.
local function players(ctx): { number }
	local list = {}
	for _, e in ctx:each({ "Player" }) do
		table.insert(list, ctx:get(e, "Player").id)
	end
	return list
end

-- Видит ли игрок хоть один тайл места месторождения с левым верхним тайлом (x, y).
local function sees(ctx, player: number, x: number, y: number): boolean
	for dy = 0, deposits.SIZE - 1 do
		for dx = 0, deposits.SIZE - 1 do
			if ctx:sees(player, x + dx + 0.5, y + dy + 0.5) then
				return true
			end
		end
	end
	return false
end

-- Выработанным заказывает смену, а те, на которых нет шахты, убирает с карты.
local function retire(ctx, state, renewal: number)
	for _, e in ctx:each({ "Deposit", "Position" }) do
		local deposit = ctx:get(e, "Deposit")
		if deposit.reserve > 0 then
			continue
		end
		if not deposit.spent then
			ctx:set(e, "Deposit", { spent = true })
			table.insert(state.due, ctx.tick + math.round(renewal * 60 / ctx.dt))
			table.sort(state.due)
		end
		if not hasMine(ctx, ctx:get(e, "Position")) then
			ctx:destroy(e)
		end
	end
end

-- Место под новое месторождение: случайная клетка карты, где месторождения нет и никто не помнит ушедшего; в клетке —
-- место, где можно строить, вдали от зданий и, если есть туман, не на глазах у игроков. Не нашлось за tries клеток —
-- nil.
local function renewedSpot(ctx, state, setup)
	local data = mechanic.data
	local config, bounds = setup.config, setup.bounds
	local seed = config.seed + data.salt
	local cell = deposits.CELL
	local left, top = math.floor(bounds.left / cell), math.floor(bounds.top / cell)
	local columns = math.floor((bounds.right - 1) / cell) - left + 1
	local rows = math.floor((bounds.bottom - 1) / cell) - top + 1
	local fog = not (ctx.game.data and ctx.game.data.fog == false)
	local everyone = players(ctx)
	-- Основания зданий и строек: новое встаёт не ближе clearance к любому из них.
	local bases = {}
	for _, e in ctx:each({ "Building", "Position" }) do
		local building, p = ctx:get(e, "Building"), ctx:get(e, "Position")
		table.insert(bases, { x = p.x - building.width / 2, y = p.y - building.height / 2, width = building.width, height = building.height })
	end
	local function clear(x: number, y: number): boolean
		for _, base in bases do
			local dx = math.max(base.x - (x + deposits.SIZE), x - (base.x + base.width), 0)
			local dy = math.max(base.y - (y + deposits.SIZE), y - (base.y + base.height), 0)
			if math.sqrt(dx * dx + dy * dy) < data.clearance then
				return false
			end
		end
		return true
	end
	local function unseen(x: number, y: number): boolean
		if not fog then
			return true
		end
		for _, player in everyone do
			if sees(ctx, player, x, y) then
				return false
			end
		end
		return true
	end
	for _ = 1, data.tries do
		local n = state.spawned
		state.spawned += 1
		local cellX = left + math.floor(ctx.hash(n, 0, seed) * columns)
		local cellY = top + math.floor(ctx.hash(n, 1, seed) * rows)
		local x0, y0 = cellX * cell, cellY * cell
		local taken = false
		for _, e in ctx:each({ "Deposit", "Position" }) do
			local p = ctx:get(e, "Position")
			if math.floor((p.x - deposits.SIZE / 2) / cell) == cellX and math.floor((p.y - deposits.SIZE / 2) / cell) == cellY then
				taken = true
				break
			end
		end
		if taken or ctx:remembered_in(x0, y0, x0 + cell, y0 + cell) then
			continue
		end
		local spot = deposits.placeIn(ctx, ctx.protos.deposits, config, bounds, cellX, cellY, function(k: number): number
			return ctx.hash(n, k + 2, seed)
		end, function(x: number, y: number): boolean
			return clear(x, y) and unseen(x, y)
		end)
		if spot then
			return spot
		end
	end
	return nil
end

-- Кладёт новые месторождения, чей срок подошёл.
local function spawn(ctx, state)
	local setup = deposits.setup(ctx)
	if not setup then
		return
	end
	while #state.due > 0 and state.due[1] <= ctx.tick do
		local spot = renewedSpot(ctx, state, setup)
		if not spot then
			return
		end
		table.remove(state.due, 1)
		ctx:spawn("deposits/" .. spot.kind, {
			Position = { x = spot.x + deposits.SIZE / 2, y = spot.y + deposits.SIZE / 2 },
			Deposit = { reserve = spot.reserve, total = spot.reserve },
		})
	end
end

mechanic.systems = {
	renew = {
		query = { "Deposit" },
		every = mechanic.data.check,
		run = function(_, ctx)
			local rules = ctx.game.data and ctx.game.data.rules or {}
			local renewal = rules.depositRenewal or 0
			if renewal <= 0 then
				return
			end
			local state = stateOf(ctx)
			retire(ctx, state, renewal)
			spawn(ctx, state)
		end,
	},
}

return mechanic
