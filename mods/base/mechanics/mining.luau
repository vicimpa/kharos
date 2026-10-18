--!strict
-- Добыча и переработка. Шахты добывают руду из месторождения под собой в свой склад, пока там есть место: что и как
-- быстро — решает месторождение, а скорость растёт с уровнем шахты. Переработка превращает свою руду в ресурс со своей
-- долей энергии, пока ему есть куда лечь. Возят руду и ресурс грузовики и трубы (mechanics/hauling, mechanics/pipes).

local economy = require("lib/economy")
local goods = require("lib/goods")
local kinds = require("lib/kinds")
local levels = require("lib/levels")
local logistics = require("lib/logistics")

local EPSILON = goods.EPSILON

local mechanic = {}

mechanic.data = {
	-- Сколько руды переработка принимает в секунду и сколько её уходит на единицу ресурса.
	refineRate = 1.5,
	refineRatio = 1,
}

mechanic.systems = {
	-- После производства: переработка превращает руду в готовое.
	refine = {
		query = { "Inventory", "Building" },
		after = { "produce" },
		before = { "plan" },
		run = function(q, ctx)
			local d = mechanic.data
			for i = 0, q.n - 1 do
				local e = buffer.readf64(q.entity, i * 8)
				local kind = kinds.of(ctx, e)
				local ore = kind and kind.data.refines
				if not ore or ctx:has(e, "Site") then
					continue
				end
				local stock = ctx:get(e, "Inventory")
				local has = goods.amount(stock, ore)
				if has <= EPSILON then
					continue
				end
				local product = goods.resourceOf(ctx, ore)
				local wanted = math.min(d.refineRate * levels.factorOf(ctx, e) * ctx.dt * economy.shareOf(ctx, e), has)
				local taken = math.min(wanted, goods.room(stock, product) * d.refineRatio)
				if taken > EPSILON then
					goods.put(stock, product, goods.take(stock, ore, taken) / d.refineRatio)
					ctx:set(e, "Inventory", { items = stock.items })
				end
			end
		end,
	},

	-- После стройки и труб, до грузовиков: шахты добывают.
	extract = {
		after = { "pipes" },
		before = { "haul" },
		run = function(_, ctx)
			for _, mine in ctx:each({ "Building", "Inventory" }) do
				local kind = kinds.of(ctx, mine)
				if not kind or not kind.data.extract or ctx:has(mine, "Site") then
					continue
				end
				local deposit = logistics.depositUnder(ctx, mine)
				local ore = logistics.mineOre(ctx, mine)
				if not deposit or not ore then
					continue
				end
				local stock = ctx:get(mine, "Inventory")
				local spot = ctx:get(deposit, "Deposit")
				local rate = kinds.of(ctx, deposit).data.rate * levels.factorOf(ctx, mine)
				local taken = math.min(rate * ctx.dt, goods.room(stock, ore), spot.reserve)
				if taken > 0 then
					goods.put(stock, ore, taken)
					ctx:set(mine, "Inventory", { items = stock.items })
					ctx:set(deposit, "Deposit", { reserve = spot.reserve - taken })
				end
			end
		end,
	},
}

return mechanic
