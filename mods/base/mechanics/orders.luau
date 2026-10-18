--!strict
-- Приказы юнитам — перенос case 'move' из packages/sim-ts/src/commands.ts: свои юниты группой едут к тайлу, каждый на
-- своё место рядом с ним (ctx:move_group — orderGroupMove движка); стоп — снять путь. Приказ точкой (order,
-- resolveOrder в target.ts) решает хост: строители по своей стройке или повреждённому — строят и чинят, иначе — едут.
-- Атака точкой придёт с приказами боя (В7).

local conversion = require("lib/conversion")
local construction = require("lib/construction")
local logistics = require("lib/logistics")

local orders = {}

-- Свои живые юниты из списка, без повторов.
local function own(ctx, player: number, units: any): { number }
	local list, seen = {}, {}
	if type(units) ~= "table" then
		return list
	end
	for _, entity in units do
		if type(entity) == "number" and not seen[entity] and ctx:alive(entity) and ctx:has(entity, "Mover") then
			seen[entity] = true
			local owner = ctx:get(entity, "Owner")
			if owner and owner.player == player then
				table.insert(list, entity)
			end
		end
	end
	return list
end

-- Насколько мимо юнита можно попасть точкой приказа, чтобы всё равно попасть в него, в тайлах (ORDER_MARGIN).
orders.data = { margin = 0.3 }

-- Свой юнит под точкой: ближайший из тех, в чей круг с запасом она попала (unitNear).
local function unitNear(ctx, player: number, x: number, y: number): number?
	local best, bestDistance = nil, math.huge
	for _, e in ctx:each({ "Unit", "Position", "Mover", "Owner" }) do
		if ctx:get(e, "Owner").player ~= player then
			continue
		end
		local at = ctx:get(e, "Position")
		local distance = math.sqrt((at.x - x) ^ 2 + (at.y - y) ^ 2)
		if distance <= ctx:get(e, "Mover").radius + orders.data.margin and distance < bestDistance then
			best, bestDistance = e, distance
		end
	end
	return best
end

-- Свои юниты едут к тайлу: приказ идти снимает строителя со стройки, грузовик — с работы и шахты.
local function move(ctx, player: number, units: { number }, x: number, y: number)
	for _, e in units do
		ctx:remove(e, "Builds")
	end
	ctx:emit("release", { units = units })
	ctx:move_group(units, x, y)
	conversion.forget(ctx, units)
	ctx:signal("moved", { player = player, x = x, y = y })
end

orders.commands = {
	-- { units, x, y } — приказ точкой (в тайлах, можно дробной): что с ней делать, решает хост. Точка в тумане — всегда
	-- движение: что там стоит, игрок не знает.
	order = function(ctx, player, args)
		if type(args.x) ~= "number" or type(args.y) ~= "number" then
			return
		end
		local units = own(ctx, player, args.units)
		if #units == 0 then
			return
		end
		local x, y = math.floor(args.x), math.floor(args.y)
		if ctx:sees(player, x, y) then
			-- Работа для строителей: стройка, разбор или своё повреждённое — здание или юнит.
			local planned = construction.siteAt(ctx, x, y)
			local broken = unitNear(ctx, player, args.x, args.y) or ctx:occupant(x, y)
			local site = planned or (if broken and construction.canRepair(ctx, player, broken) then broken else nil)
			local builders = false
			for _, e in units do
				builders = builders or ctx:has(e, "Repair")
			end
			-- Грузовики по своей шахте — привязываются к ней и возят добытое.
			local trucks = false
			for _, e in units do
				trucks = trucks or ctx:has(e, "Hauler")
			end
			local mine = ctx:occupant(x, y)
			if trucks and mine and logistics.isReady(ctx, player, mine) and logistics.dataOf(ctx, mine).extract then
				ctx:emit("haul", { player = player, units = units, mine = mine })
				return
			end
			if site and builders and ctx:get(site, "Owner").player == player then
				ctx:emit("assist", { player = player, units = units, site = site })
				return
			end
		end
		move(ctx, player, units, x, y)
	end,

	-- { units = { сущности }, x, y } — свои юниты едут к тайлу.
	move = function(ctx, player, args)
		if type(args.x) ~= "number" or type(args.y) ~= "number" then
			return
		end
		local units = own(ctx, player, args.units)
		if #units == 0 then
			return
		end
		move(ctx, player, units, args.x, args.y)
	end,

	-- { units } — стоять.
	stop = function(ctx, player, args)
		local units = own(ctx, player, args.units)
		for _, entity in units do
			ctx:stop(entity)
			ctx:remove(entity, "Builds")
		end
		ctx:emit("release", { units = units })
		conversion.forget(ctx, units)
	end,
}

return orders
