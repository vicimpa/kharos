--!strict
-- Цеха — перенос assembly.ts: собирают изделие своего вида из ресурсов. Сборка начинается, когда на складе есть сырьё на
-- неё и место под готовое, — сырьё сразу уходит в работу; идёт на долю энергии. Готовое ложится на склад цеха, откуда
-- его разбирают заявки и вывозят грузовики. Новый цех стоит выключенным (Assembly.on), пока игрок его не включит:
-- иначе он сразу съел бы сырьё зоны.

local goods = require("lib/goods")
local economy = require("lib/economy")

local readf64 = buffer.readf64

local mechanic = {}

local EPSILON = goods.EPSILON

mechanic.data = {
	-- Сколько единиц сырья цех перерабатывает в секунду, всех видов вместе (ASSEMBLE_RATE).
	rate = 1,
}

mechanic.components = {
	-- Цех: что собирает, включён ли и сколько секунд идёт нынешняя сборка.
	Assembly = { recipe = "", on = false, progress = 0 },
}

-- Сколько секунд идёт одна сборка изделия (cycleSeconds).
function mechanic.cycle(product): number
	local total = 0
	for _, amount in product.data.recipe do
		total += amount
	end
	return total / mechanic.data.rate
end

-- Есть ли у цеха место под готовое одной сборки (hasRoom).
local function hasRoom(stock, product): boolean
	return goods.room(stock, product.name) >= product.data.yield - EPSILON
end

mechanic.systems = {
	-- После переработки: цеха собирают изделия из привезённого сырья.
	assemble = {
		query = { "Assembly", "Inventory" },
		after = { "refine" },
		before = { "plan" },
		run = function(q, ctx)
			for i = 0, q.n - 1 do
				local e = readf64(q.entity, i * 8)
				if ctx:has(e, "Site") then
					continue
				end
				local assembly = ctx:get(e, "Assembly")
				local product = ctx.protos.goods[assembly.recipe]
				if not product then
					continue
				end
				local stock = ctx:get(e, "Inventory")
				local progress = assembly.progress
				if progress <= 0 then
					-- Можно ли начать: сырьё на месте и под готовое есть место.
					if not assembly.on or not hasRoom(stock, product) then
						continue
					end
					local ready = true
					for good, amount in product.data.recipe do
						if goods.amount(stock, good) < amount - EPSILON then
							ready = false
						end
					end
					if not ready then
						continue
					end
					for good, amount in product.data.recipe do
						goods.take(stock, good, amount)
					end
					-- Сырьё ушло в работу — сборка начата, даже если энергии сейчас нет.
					progress = EPSILON
				end
				local cycle = mechanic.cycle(product)
				progress = math.min(cycle, progress + ctx.dt * economy.shareOf(ctx, e))
				-- Готовому некуда лечь — сборка ждёт, пока грузовики не освободят склад.
				if progress >= cycle - EPSILON and hasRoom(stock, product) then
					goods.put(stock, product.name, product.data.yield)
					progress = 0
				end
				ctx:set(e, "Assembly", { progress = progress })
				ctx:set(e, "Inventory", { items = stock.items })
			end
		end,
	},
}

return mechanic
