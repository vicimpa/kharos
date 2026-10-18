--!strict
-- Реакторы. Включённый реактор жжёт стержень за стержнем со своего склада и, пока горит, вырабатывает энергию
-- (lib/economy, powerAt); без стержней и выключенный — ничего. Стержень в работе догорает и у выключенного не тает:
-- выключатель только ставит работу на паузу. Реактор с топливом — внутри или в работе — носит метку движка Meltdown:
-- разрушенный, он оставляет на своём месте взрыв, который бьёт всех вокруг (meltdown); топливо сгорает в нём.

local goods = require("lib/goods")
local kinds = require("lib/kinds")

local readf64 = buffer.readf64

local mechanic = {}

mechanic.components = {
	-- Реактор: сколько тиков ещё горит стержень в работе.
	Reactor = { left = 0 },
}

-- Снаряжение вида: реактор жжёт стержни.
function mechanic.equip(kind, entity)
	if kind.data.burns then
		entity.Reactor = {}
	end
end

mechanic.systems = {
	-- До энергии: реакторы жгут стержни и берут следующий со склада, как только догорит нынешний.
	burn = {
		query = { "Reactor", "Building", "Inventory" },
		before = { "busy" },
		run = function(q, ctx)
			for i = 0, q.n - 1 do
				local entity = readf64(q.entity, i * 8)
				local kind = kinds.of(ctx, entity)
				local data = kind and kind.data
				if not data or not data.burns then
					continue
				end
				local left = readf64(q.Reactor.left, i * 8)
				local stock = ctx:get(entity, "Inventory")
				local rods = goods.amount(stock, data.burns.good)
				if not ctx:has(entity, "Off") then
					if left > 0 then
						left -= 1
					end
					if left <= 0 and rods >= 1 then
						goods.take(stock, data.burns.good, 1)
						ctx:set(entity, "Inventory", { items = stock.items })
						rods -= 1
						left = math.floor(data.burns.seconds / ctx.dt + 0.5)
					end
					ctx:set(entity, "Reactor", { left = left })
				end
				-- С топливом — внутри или в работе — разрушенный взорвётся.
				local fueled = left > 0 or rods > 0
				if data.meltdown and fueled ~= ctx:has(entity, "Meltdown") then
					if fueled then
						ctx:add(entity, "Meltdown", { radius = data.meltdown.radius, damage = data.meltdown.damage })
					else
						ctx:remove(entity, "Meltdown")
					end
				end
			end
		end,
	},
}

return mechanic
