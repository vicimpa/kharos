--!strict
-- Очередь приказов юнитов — перенос packages/sim-ts/src/orders.ts. Приказ с Shift встаёт юнитам в конец очереди, а
-- стройка из меню — в очередь занятым строителям; освободившиеся юниты берут следующий приказ сами (mechanics/orders,
-- система follow). Приказ без Shift очередь забывает. Очередь — компонент Orders: list — по порядку { group, name,
-- args }; group — номер группы: приказ группы ждёт, пока освободятся все её юниты, и они получают его вместе.

local queue = {}

-- Приказы, которые можно ставить в очередь: у них есть конец или их дело ведёт юнит сам (QUEUED).
queue.QUEUED = { move = true, attack = true, assist = true, haul = true, pickup = true }
-- Сколько приказов может ждать в очереди юнита: дальше новые не встают (ORDERS_LIMIT).
queue.LIMIT = 32

-- Копия таблицы мира: таблицы ctx:get защищены, table.clone их не берёт.
function queue.copy(source: { [any]: any }): { [any]: any }
	local copy = {}
	for key, value in source do
		copy[key] = value
	end
	return copy
end

local function listOf(ctx, e: number): { any }
	local orders = ctx:get(e, "Orders")
	return if orders then orders.list else {}
end

-- Приказ без Shift забывает очередь (clearOrders).
function queue.forget(ctx, units: { number })
	for _, e in units do
		if ctx:alive(e) and #listOf(ctx, e) > 0 then
			ctx:set(e, "Orders", { list = {} })
		end
	end
end

-- Строитель на работе, которую дал ему игрок, или с приказами в очереди: новую стройку из меню он берёт в очередь
-- (isBusyBuilder).
function queue.busyBuilder(ctx, e: number): boolean
	local builds = ctx:get(e, "Builds")
	return (builds ~= nil and builds.ordered) or #listOf(ctx, e) > 0
end

-- Номер группы: в пределах тика — по порядку; разным тикам номера не пересекаются.
local lastTick, seq = -1, 0
local function nextGroup(ctx): number
	if ctx.tick ~= lastTick then
		lastTick, seq = ctx.tick, 0
	end
	seq += 1
	return ctx.tick * 1024 + seq
end

-- Ставит приказ name с args своим юнитам units в конец очереди (queueOrder). Кому он, решает номер группы: список
-- юнитов в каждом приказе каждого юнита раздувал бы мир квадратом от их числа. Возвращает, встал ли он хоть кому-то.
function queue.push(ctx, player: number, name: string, args: { [string]: any }, units: { number }): boolean
	if not queue.QUEUED[name] then
		return false
	end
	local list, seen = {}, {}
	for _, e in units do
		local owner = type(e) == "number" and ctx:alive(e) and ctx:get(e, "Owner")
		if owner and owner.player == player and not seen[e] and ctx:has(e, "Unit") and #listOf(ctx, e) < queue.LIMIT then
			seen[e] = true
			table.insert(list, e)
		end
	end
	if #list == 0 then
		return false
	end
	local stored = {}
	for key, value in args do
		if key ~= "units" and key ~= "queue" then
			stored[key] = value
		end
	end
	local group = nextGroup(ctx)
	for _, e in list do
		local orders = queue.copy(listOf(ctx, e))
		table.insert(orders, { group = group, name = name, args = stored })
		if ctx:has(e, "Orders") then
			ctx:set(e, "Orders", { list = orders })
		else
			ctx:add(e, "Orders", { list = orders })
		end
	end
	return true
end

return queue
