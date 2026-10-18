--!strict
-- Уровни зданий — перенос upgrades.ts: приказы поднять здание на уровень и отменить подъём. Цена, что уровень даёт и
-- чего не хватает — lib/levels; работу делают строители, как стройку (mechanics/construction): здание всё это время
-- работает, а повреждённое сначала чинят.

local levels = require("lib/levels")

local mechanic = {}

mechanic.components = {
	-- Здание поднимают на следующий уровень: progress — тики работы строителей; scale — по какому Rules.upgradeScale
	-- заказано: отмена возвращает уплаченное, и срок работы — от него же.
	Upgrade = { progress = 0, scale = 1 },
}

mechanic.commands = {
	-- { building, builders } — поднять своё готовое здание на следующий уровень (orderUpgrade): цена списывается сразу,
	-- готовое — со складов его энергосети; строители — к нему, а без них возьмутся свободные поблизости.
	upgrade = function(ctx, player, args)
		local building = args.building
		if type(building) ~= "number" or not ctx:alive(building) or not levels.order(ctx, player, building) then
			return
		end
		local builders = if type(args.builders) == "table" then args.builders else {}
		if #builders > 0 then
			ctx:emit("assist", { player = player, site = building, units = builders })
		end
	end,

	-- { building } — отменить подъём (cancelUpgrade): цена вернётся целиком, вложенная работа пропадёт.
	cancelUpgrade = function(ctx, player, args)
		if type(args.building) == "number" and ctx:alive(args.building) then
			levels.cancel(ctx, player, args.building)
		end
	end,
}

return mechanic
