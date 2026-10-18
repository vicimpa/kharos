--!strict
-- Тактика юнитов — общее хосту и клиенту: стойки по порядку кнопок, кто может воевать (сам или турелями на нём), турели
-- носителя. Стойку и бой ведёт движок (crates/world/src/combat.rs), патруль и возвращение на место — mechanics/tactics.

local tactics = {}

-- Стойки по порядку кнопок.
tactics.stances = { "aggressive", "defensive", "hold", "passive" }

-- Дальше этого от места, где стоял, юнит в обороне за врагом не гонится, в тайлах (LEASH — его держит движок).
tactics.leash = 8
-- Сколько точек может быть в патруле.
tactics.patrolLimit = 8

-- Турели на носителе: сущности с Attached, у которых он — parent.
function tactics.turretsOf(ctx, entity: number): { number }
	local list = {}
	for _, e in ctx:each({ "Attached" }) do
		if ctx:get(e, "Attached").parent == entity then
			table.insert(list, e)
		end
	end
	return list
end

-- Турели всех носителей разом: носитель → его турели. Для обхода многих юнитов — чтобы не искать у каждого заново.
function tactics.mounts(ctx): { [number]: { number } }
	local turrets = {}
	for _, e in ctx:each({ "Attached" }) do
		local parent = ctx:get(e, "Attached").parent
		turrets[parent] = turrets[parent] or {}
		table.insert(turrets[parent], e)
	end
	return turrets
end

-- Может ли юнит воевать: вооружён сам или несёт вооружённую турель.
function tactics.canFight(ctx, entity: number, turrets: { number }?): boolean
	if ctx:has(entity, "Armed") then
		return true
	end
	for _, turret in turrets or tactics.turretsOf(ctx, entity) do
		if ctx:has(turret, "Armed") then
			return true
		end
	end
	return false
end

-- Стойка юнита: без тактики — оборона.
function tactics.stanceOf(ctx, entity: number): string
	local own = ctx:get(entity, "Tactics")
	return if own then own.stance else "defensive"
end

-- Союзник ли игроку other (allied): он в списке союзников игрока.
function tactics.allied(ctx, player: number, other: number): boolean
	for _, e in ctx:each({ "Player" }) do
		local own = ctx:get(e, "Player")
		if own.id == player then
			return table.find(own.allies or {}, other) ~= nil
		end
	end
	return false
end

-- Можно ли атаковать цель: живой юнит или здание чужого игрока, не союзника.
function tactics.canAttack(ctx, player: number, target: number): boolean
	if not ctx:alive(target) or not ctx:has(target, "Health") or not ctx:has(target, "Position") then
		return false
	end
	if not ctx:has(target, "Unit") and not ctx:has(target, "Building") then
		return false
	end
	local owner = ctx:get(target, "Owner")
	if not owner or owner.player == player or owner.player == 0 or player == 0 then
		return false
	end
	return not tactics.allied(ctx, player, owner.player)
end

-- Дальше — только хосту: правят мир.

-- Бросает цель — свою и турелей на нём.
function tactics.stopAttack(ctx, entity: number)
	local gunners = tactics.turretsOf(ctx, entity)
	table.insert(gunners, entity)
	for _, gunner in gunners do
		if ctx:has(gunner, "Armed") then
			ctx:set(gunner, "Armed", { target = -1, chase = false, ordered = false })
		end
	end
end

-- Снимает патруль и возвращение на место (оно же — место назначения похода): юнит слушает приказ игрока. Стойка
-- остаётся.
function tactics.clear(ctx, entity: number)
	if ctx:has(entity, "Tactics") then
		ctx:set(entity, "Tactics", { patrol = {}, leg = 0, away = false, resupply = false })
	end
end

-- Поход: свои вооружённые юниты в агрессивной стойке, посланные идти, запоминают, куда идут, — конец своего пути. По
-- дороге они бьют тех, кто им опасен, и гонятся за ними, а потом идут дальше (fight движка и mechanics/tactics). В
-- других стойках приказ идти — просто идти.
function tactics.march(ctx, units: { number })
	local turrets = tactics.mounts(ctx)
	for _, entity in units do
		local path = ctx:get(entity, "Path")
		if path and tactics.stanceOf(ctx, entity) == "aggressive" and tactics.canFight(ctx, entity, turrets[entity]) then
			ctx:set(entity, "Tactics", { away = true, homeX = path.goalX, homeY = path.goalY })
		end
	end
end

return tactics
