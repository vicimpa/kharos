--!strict
-- Разворачивание и сворачивание — перенос conversion.ts: MCV разворачивается в главное здание за 3 секунды, здание
-- сворачивается обратно за 10. Посланный развернуться в другом месте MCV едет туда (Deploys) и, доехав,
-- разворачивается; не доехал — пробует снова, всё реже, и бросает. Свои стоящие юниты уходят из-под будущего здания
-- сами, чужих MCV ждёт. Очередь производства и прочность переезжают вместе: заказы не теряются, а свернув разбитое
-- здание, целую машину не получить. Правила места — lib/conversion.

local conversion = require("lib/conversion")
local placement = require("lib/placement")
local queue = require("lib/queue")
local drops = require("lib/drops")

local readf64, writef64 = buffer.readf64, buffer.writef64

local mechanic = {}

mechanic.data = {
	-- Что во что превращается: юнит и здание.
	unit = "mcv",
	building = "command",
	-- Сколько секунд MCV разворачивается и сколько здание сворачивается (DEPLOY_SECONDS, PACK_SECONDS).
	deploySeconds = 3,
	packSeconds = 10,
	-- Раз во сколько тиков недоехавший MCV пробует снова; с каждым промахом — вдвое реже (DEPLOY_RETRY_TICKS).
	retryTicks = 20,
	-- После скольких промахов подряд MCV бросает поездку (DEPLOY_MISSES).
	misses = 5,
	-- Раз во сколько тиков разворачивающийся MCV просит своих уйти из-под будущего здания (EVICT_TICKS).
	evictTicks = 20,
}

mechanic.components = {
	-- Превращение идёт: сколько тиков осталось и сколько всего.
	Converting = { left = 0, total = 0 },
	-- MCV послан развернуться в другом месте: левый верхний тайл здания и сколько раз не доехал.
	Deploys = { x = 0, y = 0, misses = 0 },
}

-- Тик сущности: раз в ticks тиков, у каждой в свой (onTurn).
local function onTurn(ctx, entity: number, ticks: number): boolean
	return (ctx.tick + entity) % ticks == 0
end

-- Начинает превращение: оно кончится через seconds.
local function start(ctx, entity: number, seconds: number)
	local ticks = math.round(seconds / ctx.dt)
	ctx:stop(entity)
	ctx:add(entity, "Converting", { left = ticks, total = ticks })
	-- Юнит, который разворачивается, с места не трогается (orderMove).
	if ctx:has(entity, "Mover") then
		ctx:set(entity, "Mover", { rooted = true })
	end
	local at = ctx:get(entity, "Position")
	ctx:signal("converting", { entity = entity, x = at.x, y = at.y })
end

-- Превращение снято, а машина осталась машиной: снова ездит.
local function stopConverting(ctx, entity: number)
	ctx:remove(entity, "Converting")
	if ctx:has(entity, "Mover") then
		ctx:set(entity, "Mover", { rooted = false })
	end
end

-- Стоит ли MCV на основании будущего здания с левым верхним тайлом (x, y): дальше ехать незачем.
local function standsOn(ctx, entity: number, x: number, y: number): boolean
	local at = ctx:get(entity, "Position")
	local data = conversion.building(ctx).data
	return at.x >= x and at.x < x + data.width and at.y >= y and at.y < y + data.height
end

-- Середина основания с левым верхним тайлом (x, y): туда едет MCV.
local function middleOf(ctx, x: number, y: number): (number, number)
	local data = conversion.building(ctx).data
	return x + math.floor(data.width / 2), y + math.floor(data.height / 2)
end

local function inBounds(ctx, x: number, y: number): boolean
	local size = ctx.game.data and ctx.game.data.size
	return not size or (x >= -size and y >= -size and x < size and y < size)
end

local function isTile(value: any): boolean
	return type(value) == "number" and value == math.floor(value)
end

-- Освобождает место под главное здание и говорит, свободно ли оно (clearGround): свои стоящие с evict уходят, тех,
-- кто едет, не трогают, чужих остаётся ждать.
local function clearSite(ctx, mcv: number, evict: boolean): boolean
	local x, y = conversion.site(ctx, mcv)
	local data = conversion.building(ctx).data
	local inside = {}
	for _, entity in ctx:units_in(x, y, data.width, data.height) do
		if entity ~= mcv then
			table.insert(inside, entity)
		end
	end
	if #inside == 0 then
		return true
	end
	if evict then
		local player = ctx:get(mcv, "Owner").player
		local own = {}
		for _, entity in inside do
			local owner = ctx:get(entity, "Owner")
			if owner and owner.player == player and not ctx:has(entity, "Path") then
				table.insert(own, entity)
			end
		end
		ctx:evict(own, x, y, data.width, data.height, conversion.unit(ctx).data.radius)
	end
	return false
end

mechanic.commands = {
	-- { unit, x?, y? } — с местом (левый верхний тайл здания) ехать туда и развернуться, без него — на месте. Годится ли
	-- место, решается на месте: в тумане там может стоять чужое, и отказ сразу выдал бы это (orderDeploy).
	deploy = function(ctx, player, args)
		local unit = args.unit
		if type(unit) ~= "number" or not ctx:alive(unit) then
			return
		end
		if args.x == nil and args.y == nil then
			if conversion.canDeploy(ctx, player, unit) then
				queue.forget(ctx, { unit })
				start(ctx, unit, mechanic.data.deploySeconds)
			end
			return
		end
		local x, y = args.x, args.y
		if not isTile(x) or not isTile(y) or not conversion.canSend(ctx, player, unit) then
			return
		end
		local data = conversion.building(ctx).data
		if not inBounds(ctx, x, y) or not inBounds(ctx, x + data.width - 1, y + data.height - 1) then
			return
		end
		if standsOn(ctx, unit, x, y) then
			if not conversion.canDeployAt(ctx, player, unit, x, y) then
				return
			end
			ctx:add(unit, "Deploys", { x = x, y = y, misses = 0 })
			start(ctx, unit, mechanic.data.deploySeconds)
			return
		end
		queue.forget(ctx, { unit })
		ctx:add(unit, "Deploys", { x = x, y = y, misses = 0 })
		ctx:move(unit, middleOf(ctx, x, y))
	end,

	-- { unit } — отменить разворачивание или поездку на него: MCV остаётся машиной и стоит (cancelDeploy).
	cancelDeploy = function(ctx, player, args)
		local unit = args.unit
		if type(unit) ~= "number" or not ctx:alive(unit) or not ctx:has(unit, "Unit") then
			return
		end
		local owner = ctx:get(unit, "Owner")
		if not owner or owner.player ~= player then
			return
		end
		local converting = ctx:has(unit, "Converting")
		if not converting and not ctx:has(unit, "Deploys") then
			return
		end
		if not converting then
			ctx:stop(unit)
		end
		stopConverting(ctx, unit)
		ctx:remove(unit, "Deploys")
	end,

	-- { building } — свернуть своё главное здание обратно в MCV.
	pack = function(ctx, player, args)
		local building = args.building
		if type(building) == "number" and ctx:alive(building) and conversion.canPack(ctx, player, building) then
			start(ctx, building, mechanic.data.packSeconds)
		end
	end,
}

mechanic.systems = {
	-- Посланные разворачиваться MCV, доехав, разворачиваются; место негодно — приказ снимается. Не доехал — пробует
	-- снова, всё реже, и после misses промахов бросает (deployOrders). До превращений: доехавший начнёт в этот же тик.
	deploy_orders = {
		query = { "Deploys", "Position" },
		write = { "Deploys" },
		before = { "convert" },
		run = function(q, ctx)
			local data = mechanic.data
			local d = q.Deploys
			for i = 0, q.n - 1 do
				local at = i * 8
				local entity = readf64(q.entity, at)
				if ctx:has(entity, "Converting") or ctx:has(entity, "Path") then
					continue
				end
				local x, y, misses = readf64(d.x, at), readf64(d.y, at), readf64(d.misses, at)
				if standsOn(ctx, entity, x, y) then
					if conversion.canDeployAt(ctx, ctx:get(entity, "Owner").player, entity, x, y) then
						start(ctx, entity, data.deploySeconds)
					else
						ctx:remove(entity, "Deploys")
					end
				elseif onTurn(ctx, entity, bit32.lshift(data.retryTicks, misses)) then
					misses += 1
					writef64(d.misses, at, misses)
					if misses > data.misses then
						ctx:remove(entity, "Deploys")
					else
						ctx:move(entity, middleOf(ctx, x, y))
					end
				end
			end
		end,
	},

	-- Превращения идут и кончаются. MCV, под которым стоят юниты, зданием не становится: свои из-под него уходят, пока
	-- он разворачивается, а чужих он ждёт (convert). До производства: новое здание выпускает уже в этот тик.
	convert = {
		query = { "Converting" },
		write = { "Converting" },
		before = { "produce" },
		run = function(q, ctx)
			local data = mechanic.data
			local left = q.Converting.left
			local done = {}
			for i = 0, q.n - 1 do
				local at = i * 8
				local entity = readf64(q.entity, at)
				local rest = math.max(0, readf64(left, at) - 1)
				writef64(left, at, rest)
				-- Выгонять пробуют не каждый тик: поиск пути недёшев.
				local unit = ctx:has(entity, "Unit")
				local clear = not unit or clearSite(ctx, entity, onTurn(ctx, entity, data.evictTicks))
				if rest <= 0 and clear then
					table.insert(done, entity)
				end
			end
			local building = conversion.building(ctx)
			for _, entity in done do
				ctx:remove(entity, "Converting")
				local player = ctx:get(entity, "Owner").player
				-- Очередь производства переезжает вместе с игроком, прочность — тоже.
				local production = ctx:get(entity, "Producer")
				local health = ctx:get(entity, "Health")
				local fields: { [string]: any } = { Owner = { player = player }, Health = { value = if health then health.value else 1 } }
				if production then
					fields.Producer = production
				end
				local at = ctx:get(entity, "Position")
				if ctx:has(entity, "Unit") then
					local x, y = conversion.site(ctx, entity)
					-- За время разворачивания место могли занять: тогда MCV остаётся машиной.
					if not placement.canPlace(ctx, building, x, y) then
						ctx:set(entity, "Mover", { rooted = false })
						ctx:remove(entity, "Deploys")
						continue
					end
					ctx:destroy(entity)
					-- Главное здание давит брошенный под ним груз.
					drops.clear(ctx, x, y, building.data.width, building.data.height)
					fields.Position = { x = placement.middle(x, building.data.width), y = placement.middle(y, building.data.height) }
					local made = ctx:spawn(building, fields)
					ctx:signal("converted", { entity = made, player = player, x = at.x, y = at.y })
					ctx:emit("reward", { player = player, key = "deploy" })
				else
					-- MCV встаёт посреди тайла в середине основания.
					local left = placement.left(at.x, building.data.width) + math.floor(building.data.width / 2)
					local top = placement.left(at.y, building.data.height) + math.floor(building.data.height / 2)
					ctx:destroy(entity)
					fields.Position = { x = left + 0.5, y = top + 0.5 }
					local made = ctx:spawn(conversion.unit(ctx), fields)
					ctx:signal("converted", { entity = made, player = player, x = at.x, y = at.y })
				end
			end
		end,
	},
}

-- На клиенте: превращение началось — лязг разворачивания, кончилось — новое встаёт на место (worldSounds.ts).
mechanic.signals = {
	converting = function(c, signal)
		c:sound("deploy", { x = signal.x, y = signal.y, volume = 0.5 })
	end,
	converted = function(c, signal)
		c:sound("built", { x = signal.x, y = signal.y, volume = 0.5 })
	end,
}

return mechanic
