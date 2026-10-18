--!strict
-- Турели на носителях: новой сущности, у вида которой есть data.mounts, ставятся турели — свои сущности с Attached
-- (компонент движка: носитель, вперёд и вправо от его центра, свой поворот); здание получает их достроенным. Каждый
-- тик после хода закреплённое встаёт на своё место и смотрит туда же, куда носитель, плюс свой поворот; закреплённое
-- на погибшем исчезает — это система движка follow (followCarriers в sim-ts).

local supply = require("lib/supply")

local mounts = {}

mounts.components = {
	-- Метка турели: куда она смотрит — Attached.angle.
	Turret = {},
}

-- Ставит турели вида на сущность.
local function mount(ctx, entity: number, proto: number)
	local kind = ctx:proto(proto)
	local list = kind.data and kind.data.mounts
	if not list then
		return
	end
	local at = ctx:get(entity, "Position")
	local facing = ctx:get(entity, "Facing")
	local owner = ctx:get(entity, "Owner")
	for _, item in list do
		local turret = ctx.protos.turrets[item.turret]
		local weapon = turret and turret.data.weapon and ctx.protos.weapons[turret.data.weapon]
		ctx:spawn("turrets/" .. item.turret, {
			Position = { x = at.x, y = at.y },
			Facing = { angle = if facing then facing.angle else 0 },
			Owner = { player = if owner then owner.player else 0 },
			Attached = { parent = entity, along = item.along, across = item.across },
			-- Выстрел турели стоит магазину носителя (lib/supply).
			Armed = if weapon then { cost = supply.costOn(kind, ctx.protos, weapon) } else nil,
		})
	end
end

mounts.on = {
	-- Площадке турели не положены: здание получит их, когда его достроят (mountTurrets в equip).
	spawned = function(ctx, event)
		if event.proto and not ctx:has(event.entity, "Site") then
			mount(ctx, event.entity, event.proto)
		end
	end,
	built = function(ctx, event)
		local proto = ctx:alive(event.entity) and ctx:get(event.entity, "Proto")
		if proto then
			mount(ctx, event.entity, proto.id)
		end
	end,
}

mounts.systems = {
	follow = { engine = "follow", after = { "move" } },
}

return mounts
