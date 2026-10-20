--!strict
-- Торговля: заявки на продажу и закупку с орбиты, корабли космопорта. Расчёты — lib/trade, подвоз товара в трюм —
-- заявка космопорта в lib/logistics: из своей сети он идёт по трубам, из других — грузовиками.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local trade = require("lib/trade")
local wallet = require("lib/wallet")

local readf64 = buffer.readf64

local mechanic = {}

-- Кусок панели игрока (ui/hud).
mechanic.panel = require("./panel")

mechanic.components = {
	-- Заявка космопорта: что и сколько продать или купить (buy); left и total — сколько тиков лететь кораблю, пока товар
	-- везут — нули. Закупка оплачена сразу, и корабль летит с самого начала.
	Trade = { resource = "", wanted = 0, left = 0, total = 0, buy = false },
}

local function whole(value: any): number?
	if type(value) ~= "number" or value ~= value or value < 1 or value == math.huge then
		return nil
	end
	return math.floor(value)
end

mechanic.commands = {
	-- { port, resource, amount } — заявка на продажу до amount единиц (sell): продать можно весь запас игрока, но не
	-- больше трюма; космопорт должен стоять в сети.
	sell = function(ctx, player, args)
		local port, resource, amount = args.port, args.resource, whole(args.amount)
		if type(port) ~= "number" or type(resource) ~= "string" or not amount or not trade.isResource(ctx, resource) then
			return
		end
		if not ctx:alive(port) or not trade.canSell(ctx, player, port) or not logistics.networkOf(ctx, port) then
			return
		end
		local hold = ctx:get(port, "Inventory")
		local room = if hold then goods.amount(hold, resource) + goods.room(hold, resource) else 0
		local stock = logistics.stockOf(ctx, player)
		local wanted = math.min(amount, math.floor(stock[resource] or 0), math.floor(room))
		if wanted >= 1 then
			ctx:add(port, "Trade", { resource = resource, wanted = wanted })
		end
	end,

	-- { port, resource, amount } — закупка с орбиты (buy): целое число единиц, сколько влезет в склад и хватит
	-- кредитов; кредиты списываются сразу.
	buy = function(ctx, player, args)
		local port, resource, amount = args.port, args.resource, whole(args.amount)
		if type(port) ~= "number" or type(resource) ~= "string" or not amount or not trade.isOrbital(ctx, resource) then
			return
		end
		if trade.buyResearch(ctx, player, resource) or not ctx:alive(port) or not trade.canSell(ctx, player, port) then
			return
		end
		local hold = ctx:get(port, "Inventory")
		local wanted = math.min(amount, math.floor(if hold then goods.room(hold, resource) else 0))
		if wanted < 1 or not wallet.pay(ctx, player, wanted * trade.buyPrice(ctx, resource)) then
			return
		end
		local ticks = trade.flightTicks(ctx, port, trade.BUY_SECONDS)
		ctx:add(port, "Trade", { resource = resource, wanted = wanted, left = ticks, total = ticks, buy = true })
	end,

	-- { port } — закрыть заявку раньше срока: корабль улетит с тем, что уже привезли, а не привезли ничего — заявка
	-- снимается. Улетевший корабль не вернуть.
	closeSale = function(ctx, player, args)
		local port = args.port
		if type(port) ~= "number" or not ctx:alive(port) or not trade.isPort(ctx, player, port) then
			return
		end
		local order = ctx:get(port, "Trade")
		if not order or order.total > 0 or order.buy then
			return
		end
		local delivered = trade.delivered(ctx, port)
		if delivered < 1e-9 then
			ctx:remove(port, "Trade")
		else
			ctx:set(port, "Trade", { wanted = delivered })
		end
	end,
}

mechanic.systems = {
	-- Корабли с полным грузом улетают, а за долетевшие платят; закупка выгружается в склад (trade).
	trade = {
		query = { "Trade", "Owner" },
		after = { "haul" },
		run = function(q, ctx)
			local purse = wallet.purse(ctx)
			for i = 0, q.n - 1 do
				local at = i * 8
				local port = readf64(q.entity, at)
				local player = readf64(q.Owner.player, at)
				local order = ctx:get(port, "Trade")
				if order.total > 0 then
					local left = order.left - 1
					if left > 0 then
						ctx:set(port, "Trade", { left = left })
						continue
					end
					-- Корабль прилетел: закупка выгружается, продажа уходит с товаром заявки, остальное в складе остаётся.
					local hold = ctx:get(port, "Inventory")
					ctx:remove(port, "Trade")
					local at = ctx:get(port, "Position")
					if order.buy then
						if hold then
							goods.put(hold, order.resource, order.wanted)
							ctx:set(port, "Inventory", { items = hold.items })
						end
						ctx:signal("landed", { player = player, x = at.x, y = at.y })
						continue
					end
					local sold = if hold then goods.take(hold, order.resource, order.wanted) else 0
					if hold then
						ctx:set(port, "Inventory", { items = hold.items })
					end
					wallet.add(purse, player, math.floor(sold * trade.price(ctx, order.resource) + 0.5))
					if sold > 0 then
						ctx:emit("reward", { player = player, key = "sale" })
					end
					ctx:signal("paid", { player = player, x = at.x, y = at.y })
				elseif trade.delivered(ctx, port) >= order.wanted - 1e-9 then
					local ticks = trade.flightTicks(ctx, port, trade.SELL_SECONDS)
					ctx:set(port, "Trade", { left = ticks, total = ticks })
					local at = ctx:get(port, "Position")
					ctx:signal("launched", { player = player, x = at.x, y = at.y })
				end
			end
			wallet.flush(purse)
		end,
	},
}

-- На клиенте: корабль взлетел с товаром — рёв старта; закупка села — посадка и «доставлено»; за проданное заплатили —
-- звон монет.
mechanic.signals = {
	launched = function(c, signal)
		c:sound("shipLaunch", { x = signal.x, y = signal.y, volume = 0.8 })
	end,
	landed = function(c, signal)
		c:sound("shipLand", { x = signal.x, y = signal.y, volume = 0.8 })
		if signal.player == c.player then
			c:sound("delivered", { volume = 0.4 })
		end
	end,
	paid = function(c, signal)
		if signal.player == c.player then
			c:sound("coins", { volume = 0.4 })
		end
	end,
}

-- По сети: заказ космопорта — только хозяину.
mechanic.net = { Trade = "owner" }

return mechanic
