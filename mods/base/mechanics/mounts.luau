--!strict
-- Турели на носителях: новой сущности, у вида которой есть data.mounts, ставятся турели — свои сущности с Attached
-- (компонент движка: носитель, вперёд и вправо от его центра, свой поворот). Каждый тик после хода закреплённое
-- встаёт на своё место и смотрит туда же, куда носитель, плюс свой поворот; закреплённое на погибшем исчезает — это
-- система движка follow (followCarriers в sim-ts).

local mounts = {}

mounts.components = {
	-- Метка турели: куда она смотрит — Attached.angle.
	Turret = {},
}

mounts.on = {
	spawned = function(ctx, event)
		if not event.proto then
			return
		end
		local kind = ctx:proto(event.proto)
		local list = kind.data and kind.data.mounts
		if not list then
			return
		end
		local at = ctx:get(event.entity, "Position")
		local facing = ctx:get(event.entity, "Facing")
		local owner = ctx:get(event.entity, "Owner")
		for _, mount in list do
			ctx:spawn("turrets/" .. mount.turret, {
				Position = { x = at.x, y = at.y },
				Facing = { angle = if facing then facing.angle else 0 },
				Owner = { player = if owner then owner.player else 0 },
				Attached = { parent = event.entity, along = mount.along, across = mount.across },
			})
		end
	end,
}

mounts.systems = {
	follow = { engine = "follow", after = { "move" } },
}

return mounts
