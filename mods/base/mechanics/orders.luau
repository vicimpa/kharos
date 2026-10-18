--!strict
-- Приказы юнитам — перенос case 'move' из packages/sim-ts/src/commands.ts: свои юниты группой едут к тайлу, каждый на
-- своё место рядом с ним (ctx:move_group — orderGroupMove движка); стоп — снять путь.

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

orders.commands = {
	-- { units = { сущности }, x, y } — свои юниты едут к тайлу.
	move = function(ctx, player, args)
		if type(args.x) ~= "number" or type(args.y) ~= "number" then
			return
		end
		local units = own(ctx, player, args.units)
		if #units == 0 then
			return
		end
		ctx:move_group(units, args.x, args.y)
		ctx:signal("moved", { player = player, x = args.x, y = args.y })
	end,

	-- { units } — стоять.
	stop = function(ctx, player, args)
		for _, entity in own(ctx, player, args.units) do
			ctx:stop(entity)
		end
	end,
}

return orders
