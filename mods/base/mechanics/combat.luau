--!strict
-- Бой — перенос combat.ts: стрелки ищут цели, гонятся, стреляют, снаряды летят и бьют, погибшие пропадают — это
-- система движка fight (crates/world/src/combat.rs), виды оружия — раздел weapons/. Здесь — что вокруг неё: турели
-- без цели разворачиваются по корпусу (restTurrets, тоже движок), прочность сама понемногу восстанавливается
-- (recover), приказы атаковать и сменить стойку.

local combat = {}

combat.components = {
	-- Чинят ли это строители (Repair): пехоту — нет, она поправляется сама.
	Health = { repairable = true },
}

combat.systems = {
	-- После движения и работ: стреляющий поворачивается к цели, и погибшие в этот тик уже ничего не делают.
	fight = { engine = "fight", after = { "follow" } },
	-- После боя: кому не досталось цели, те турели разворачиваются по корпусу.
	rest = { engine = "rest_turrets", after = { "fight" } },
	-- Кто восстанавливается сам (Health.regen), понемногу поправляется — кроме задетых в этот тик.
	recover = {
		query = { "Health" },
		write = { "Health" },
		after = { "rest" },
		run = function(q, ctx)
			local value, max, regen, hit = q.Health.value, q.Health.max, q.Health.regen, q.Health.hit
			local tick, step = ctx.tick, ctx.dt
			local read, write = buffer.readf64, buffer.writef64
			for at = 0, (q.n - 1) * 8, 8 do
				local gain, full = read(regen, at), read(max, at)
				if gain > 0 and read(hit, at) ~= tick and read(value, at) < full then
					write(value, at, math.min(full, read(value, at) + gain * step))
				end
			end
		end,
	},
}

combat.commands = {
	-- Атаковать цель: { units = { … }, target = сущность } (orderAttack).
	attack = function(ctx, player, args)
		ctx:attack(player, args.units, args.target)
	end,
	-- Стойка: { units = { … }, stance = "aggressive" | "defensive" | "hold" | "passive" } (setStance).
	stance = function(ctx, player, args)
		ctx:stance(player, args.units, args.stance)
	end,
}

return combat
