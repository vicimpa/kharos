--!strict
-- Сценка витрины: оборона — главное здание, перед ним случайное укрепление (lib/fortify) лицом к случайной стороне,
-- защитники за ним отбивают волну за волной; турели подпитываются патронами «за кадром» (defense в sim-ts/showcase.ts).

local battle = require("lib/battle")
local fortify = require("lib/fortify")
local goods = require("lib/goods")
local kinds = require("lib/kinds")
local scenery = require("lib/scenery")

-- Стороны, откуда может идти враг (SIDES); насколько волна приходит в стороне от оси обороны (WAVE_SPREAD).
local SIDES = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
local WAVE_SPREAD = 8
-- Чем идут волны, бюджет первой и прибавка к каждой следующей, сколько волн (WAVE_WEIGHTS, WAVE_BUDGET, WAVE_GROWTH, WAVES).
local WAVE_WEIGHTS = { infantry = 2, rocketeer = 1, buggy = 1, lancer = 1, tank = 1, tesla = 0.5 }
local WAVE_BUDGET, WAVE_GROWTH, WAVES = 1200, 500, 6
-- Откуда идут волны: тайлов перед самой дальней постройкой обороны (WAVE_DISTANCE).
local WAVE_DISTANCE = 20
-- Кто защищает базу вместе с турелями: случайный отряд такой цены, и при нём строители (GUARD_BUDGET, GUARD_WEIGHTS).
local GUARD_BUDGET = 1500
local GUARD_WEIGHTS = { infantry = 2, rocketeer = 2, buggy = 1, lancer = 1, tank = 1, tesla = 0.5 }

-- Точка в осях обороны (u — к врагу, v — поперёк) → тайл на карте.
local function at(state, u: number, v: number): (number, number)
	return state.x + state.sx * u - state.sy * v, state.y + state.sy * u + state.sx * v
end

-- Готов ли юнит к новому приказу: не идёт и не держит живую цель.
local function idle(ctx, e: number): boolean
	if ctx:has(e, "Path") then
		return false
	end
	local armed = ctx:get(e, "Armed")
	return not armed or armed.target < 0 or not ctx:has(armed.target, "Position")
end

return {
	create = function(ctx, player: number): boolean
		local spot = scenery.openSpot(ctx, "command", 10)
		if not spot then
			return false
		end
		local side = SIDES[ctx:random(#SIDES)]
		local state = { wave = 0, calm = 0, x = spot.x + 1, y = spot.y + 1, sx = side[1], sy = side[2], reach = 0 }
		ctx.storage.scene = state
		scenery.place(ctx, "command", spot.x, spot.y, player)
		local pieces = fortify.of(function()
			return ctx:random()
		end)
		for _, piece in pieces do
			state.reach = math.max(state.reach, piece.u)
		end
		for _, piece in pieces do
			local x, y = at(state, piece.u, piece.v)
			if scenery.canPlace(ctx, piece.type, x, y) then
				scenery.place(ctx, piece.type, x, y, player)
			end
		end
		-- Турели получают патроны по трубам: укрепление сразу собрано в одну сеть.
		scenery.connectAll(ctx, player)
		local army = battle.randomArmy(ctx, GUARD_BUDGET, battle.only(ctx, GUARD_WEIGHTS))
		table.insert(army, "builder")
		table.insert(army, "builder")
		local gx, gy = at(state, 3, 0)
		scenery.spawnGroup(ctx, army, player, gx, gy, 1)
		return true
	end,
	drive = function(ctx, player: number, seconds: number): boolean
		local state = ctx.storage.scene
		local turrets, foes = 0, 0
		local targets = {}
		for _, e in ctx:each({ "Building", "Position", "Owner" }) do
			if ctx:get(e, "Owner").player ~= player then
				continue
			end
			local kind = kinds.of(ctx, e)
			if kind and kind.data.ammo then
				turrets += 1
				-- Патроны подвозят «за кадром»: сценка про бой, а не про снабжение.
				local stock = ctx:get(e, "Inventory")
				if stock then
					goods.put(stock, "ammo", 20)
					ctx:set(e, "Inventory", { items = stock.items })
				end
			end
			local p = ctx:get(e, "Position")
			table.insert(targets, { entity = e, x = p.x, y = p.y })
		end
		for _, e in ctx:each({ "Unit", "Position", "Owner" }) do
			if ctx:get(e, "Owner").player == player then
				local p = ctx:get(e, "Position")
				table.insert(targets, { entity = e, x = p.x, y = p.y })
			end
		end
		for _, e in ctx:each({ "Unit", "Position", "Owner" }) do
			if ctx:get(e, "Owner").player ~= battle.FOE then
				continue
			end
			foes += 1
			if idle(ctx, e) then
				local p = ctx:get(e, "Position")
				local nearest, best = nil, math.huge
				for _, target in targets do
					local distance = (target.x - p.x) ^ 2 + (target.y - p.y) ^ 2
					if distance < best then
						best, nearest = distance, target.entity
					end
				end
				if nearest then
					ctx:attack(battle.FOE, { e }, nearest)
				end
			end
		end
		if turrets == 0 then
			return false
		end
		if foes > 0 then
			return true
		end
		state.calm += seconds
		if state.calm < 3 then
			return true
		end
		state.calm = 0
		if state.wave >= WAVES then
			return false
		end
		local army = battle.randomArmy(ctx, WAVE_BUDGET + state.wave * WAVE_GROWTH, battle.only(ctx, WAVE_WEIGHTS))
		local x, y = at(state, state.reach + WAVE_DISTANCE, math.round((ctx:random() * 2 - 1) * WAVE_SPREAD))
		scenery.spawnGroup(ctx, army, battle.FOE, x, y)
		state.wave += 1
		return true
	end,
}
