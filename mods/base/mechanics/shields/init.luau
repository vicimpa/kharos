--!strict
-- Щиты. Генератор щита (data.shield) держит купол — компонент движка Shield: урон по своим и союзным зданиям и юнитам
-- под ним от стрелков снаружи купола и от летающих гасит запас щита, а не прочность; кто зашёл под купол, бьёт мимо
-- щита. Чужие снаряды рвутся на краю купола. Это считает бой движка; здесь — запас.
--
-- Энергию генератор берёт постоянно, как любой потребитель: нехватка замедляет восстановление, без энергии или
-- выключенный купол гаснет и запас пропадает. Растёт запас не раньше repairPause секунд после последнего погашенного
-- попадания — то же правило, что у ремонта, иначе щит с электростанцией за спиной держал бы малый отряд вечно.
-- Пробитый до нуля купол гаснет на Shield.recover секунд и потом растёт с нуля.

local construction = require("lib/construction")
local economy = require("lib/economy")
local kinds = require("lib/kinds")

local readf64 = buffer.readf64

local mechanic = {}

-- Кусок панели игрока (ui/hud).
mechanic.panel = require("./panel")

mechanic.data = {
	-- На сколько секунд гаснет пробитый до нуля купол.
	down = 10,
}

-- Снаряжение вида: генератор щита держит купол; пробитый гаснет на down секунд.
function mechanic.equip(kind, entity)
	if kind.data.shield then
		entity.Shield = { radius = kind.data.shield.radius, recover = mechanic.data.down }
	end
end

mechanic.systems = {
	-- После боя: щиты восстанавливаются на долю энергии своей сети; без энергии купол гаснет.
	shields = {
		query = { "Shield", "Building" },
		after = { "recover" },
		run = function(q, ctx)
			local supply: { [number]: number }? = nil
			local pause = construction.rules(ctx).repairPause / ctx.dt
			local tick = ctx.tick
			for i = 0, q.n - 1 do
				local at = i * 8
				local entity = readf64(q.entity, at)
				-- Разбираемый купола не держит.
				local charge = readf64(q.Shield.charge, at)
				if ctx:has(entity, "Site") then
					if charge ~= 0 then
						ctx:set(entity, "Shield", { charge = 0 })
					end
					continue
				end
				supply = supply or economy.supply(ctx)
				local share = (supply :: any)[entity] or 0
				if share <= 0 then
					if charge ~= 0 then
						ctx:set(entity, "Shield", { charge = 0 })
					end
					continue
				end
				local hit = readf64(q.Shield.hit, at)
				if tick < readf64(q.Shield.down, at) or (hit >= 0 and tick - hit < pause) then
					continue
				end
				local kind = kinds.of(ctx, entity)
				local spec = kind and kind.data.shield
				if spec and charge < spec.capacity then
					ctx:set(entity, "Shield", { charge = math.min(spec.capacity, charge + spec.regen * share * ctx.dt) })
				end
			end
		end,
	},
}

return mechanic
