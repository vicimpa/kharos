--!strict
-- Сценка витрины: стройка — главное здание и бригада строителей, которая поднимает вокруг него базу здание за зданием.
-- Порядок — по дереву технологий: каждое здание открывают уже стоящие перед ним. Исследования сценка открывает сразу.

local construction = require("lib/construction")
local scenery = require("lib/scenery")
local kinds = require("lib/kinds")

-- Что строят по очереди и через сколько секунд после конца стройки сценка начинается заново.
local PLAN = { "generator", "radar", "generator", "barracks", "smelter", "metalYard", "matter", "turret", "rocketTurret", "siliconWorks", "siliconStore", "cannonTurret" }
local BUILT_PAUSE = 12

return {
	create = function(ctx, player: number): boolean
		local spot = scenery.openSpot(ctx, "command", 6)
		if not spot then
			return false
		end
		scenery.place(ctx, "command", spot.x, spot.y, player)
		ctx.storage.scene = { step = 0, done = 0, x = spot.x + 1, y = spot.y + 1 }
		scenery.addCredits(ctx, player, 50000)
		scenery.grantResearch(ctx, player)
		scenery.spawnGroup(ctx, { "builder", "builder", "builder", "builder", "builder", "truck", "truck", "infantry", "infantry" }, player, spot.x + 1, spot.y + 1, 3)
		return true
	end,
	drive = function(ctx, player: number, seconds: number): boolean
		local state = ctx.storage.scene
		-- Новая площадка — только когда прежние достроены: бригада работает вместе, и стройку видно.
		for _, e in ctx:each({ "Site", "Owner" }) do
			if ctx:get(e, "Owner").player == player then
				return true
			end
		end
		if state.step >= #PLAN then
			state.done += seconds
			return state.done < BUILT_PAUSE
		end
		local builders = {}
		for _, e in ctx:each({ "Repair", "Unit", "Owner" }) do
			local kind = kinds.of(ctx, e)
			if ctx:get(e, "Owner").player == player and kind and kind.name == "builder" then
				table.insert(builders, e)
			end
		end
		state.step += 1
		local name = PLAN[state.step]
		local kind = ctx.protos.buildings[name]
		local tiles = scenery.around(state.x, state.y, 12)
		for i = 1, #tiles - 1, 2 do
			local x, y = tiles[i], tiles[i + 1]
			if math.abs(x - state.x) < 4 and math.abs(y - state.y) < 4 then
				continue
			end
			if scenery.canPlace(ctx, name, x, y, 1) and construction.canBuild(ctx, player, kind, x, y) then
				ctx.protos.mechanics.construction.commands.build(ctx, player, { building = name, x = x, y = y, builders = builders })
				break
			end
		end
		return true
	end,
}
