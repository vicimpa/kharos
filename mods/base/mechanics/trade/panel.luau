--!strict
-- Торговля на панели: свой готовый космопорт — продажа и закупка с орбиты, каждая на своей странице, набор количества и
-- заявка; в сведениях — рейс, набираемая сделка или что тут можно. deal — набираемая сделка: что и сколько;
-- сбрасывается, когда выбран другой космопорт.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local research = require("lib/research")
local trade = require("lib/trade")
local wallet = require("lib/wallet")
local widgets = require("lib/widgets")

local COLORS = widgets.COLORS
local goodWith = panel.goodWith

-- Шаги набора количества и с какого количества сделка начинается.
local DEAL_STEPS = { 10, 50, 100 }
local DEAL_START = 50
local market = { port = -1, page = "root", deal = nil :: { resource: string, amount: number }? }

-- Что можно продать из запаса игрока: сколько всего, сколько в сети космопорта и почём.
local function offersOf(c, port: number)
	local items = logistics.stockOf(c, c.player)
	local network = logistics.networkOf(c, port)
	local near = if network then trade.stockOfZone(c, network) else {}
	local list = {}
	for _, name in goods.names(c) do
		local available = math.floor(items[name] or 0)
		if trade.isResource(c, name) and available >= 1 then
			table.insert(list, { resource = name, available = available, here = math.floor(near[name] or 0), price = trade.price(c, name) })
		end
	end
	return list
end

-- Что можно купить с орбиты: почём, сколько влезет в склад космопорта и что надо изучить.
local function purchasesOf(c, port: number)
	local hold = c:get(port, "Inventory")
	local list = {}
	for _, name in goods.names(c) do
		if trade.isOrbital(c, name) then
			table.insert(list, { resource = name, price = trade.buyPrice(c, name), room = if hold then math.floor(goods.room(hold, name)) else 0, research = trade.buyResearch(c, c.player, name) })
		end
	end
	return list
end

-- Сделка в пределах возможного: продажа — не больше запаса, закупка — на сколько хватает кредитов и трюма. nil — такого
-- ресурса космопорт сейчас не предлагает.
local function dealOf(c, port: number, buying: boolean, deal)
	local item, room = nil, 0
	for _, purchase in purchasesOf(c, port) do
		if purchase.resource == deal.resource then
			room = purchase.room
			if buying then
				item = purchase
			end
		end
	end
	if not buying then
		for _, offer in offersOf(c, port) do
			if offer.resource == deal.resource then
				item = offer
			end
		end
	end
	if not item then
		return nil
	end
	local max = if buying then math.max(0, math.min(room, math.floor(wallet.credits(c, c.player) / item.price))) else item.available
	return { resource = item.resource, amount = math.max(0, math.min(max, math.floor(deal.amount))), price = item.price, max = max, room = room }
end

-- Сетка космопорта: продажа и закупка — каждая на своей странице, набор количества, заявка.
local function tradeSlots(c, list, port: number)
	if market.port ~= port then
		market.port, market.page, market.deal = port, "root", nil
	end
	local order = c:get(port, "Trade")
	local function open(page: string)
		market.page, market.deal = page, nil
	end
	if market.page == "root" then
		list[panel.CONVERT] = {
			label = c:t("grid.sell"),
			picture = c.protos.buildings.spaceport,
			active = order ~= nil,
			title = if order then c:t("grid.sellingTip") else c:t("grid.sellTip"),
			hint = order == nil and (panel.currentStep(c) or {}).sell == true,
			run = function()
				open("sell")
			end,
		}
		list[panel.CANCEL] = {
			label = c:t("grid.buy"),
			picture = c.protos.buildings.spaceport,
			disabled = order ~= nil,
			title = if order then c:t("grid.buyBusyTip") else c:t("grid.buyTip"),
			run = function()
				open("buy")
			end,
		}
	elseif not order then
		local buying = market.page == "buy"
		local picked = market.deal and dealOf(c, port, buying, market.deal)
		if not picked then
			-- Сначала — что продать или купить: ячейка на ресурс. Количество — на следующем шаге.
			local items = if buying then purchasesOf(c, port) else offersOf(c, port)
			for i, item in items do
				if i > 8 then
					break
				end
				local limit = dealOf(c, port, buying, { resource = item.resource, amount = DEAL_START })
				local title = c:t(c.protos.goods[item.resource].data.title)
				local topic = item.research and research.topic(c, item.research)
				list[i] = {
					label = if buying then title else title .. " ×" .. limit.max,
					picture = c.protos.goods[item.resource],
					disabled = limit.max < 1 or item.research ~= nil,
					title = if topic then c:t("grid.needsResearch", { name = c:t(topic.data.title) })
						elseif limit.max >= 1 then (if buying then c:t("grid.buyPrice", { price = item.price })
							elseif item.here and item.here < limit.max then c:t("grid.sellFar", { price = item.price, here = item.here })
							else c:t("grid.sellPrice", { price = item.price }))
						elseif limit.room < 1 and buying then c:t("grid.noRoom")
						else c:t("grid.noCredits"),
					run = function()
						market.deal = { resource = item.resource, amount = limit.amount }
					end,
				}
			end
			list[panel.BACK] = {
				label = c:t("common.back"),
				run = function()
					open("root")
				end,
			}
		else
			-- Верхний ряд — прибавить, второй — убавить; «Всё» — сколько есть в запасе или на сколько хватает кредитов и
			-- трюма.
			local resource, amount, price, max = picked.resource, picked.amount, picked.price, picked.max
			local function set(value: number)
				market.deal = { resource = resource, amount = math.max(0, math.min(max, value)) }
			end
			for i, step in DEAL_STEPS do
				list[i] = { label = "+" .. step, disabled = amount >= max, run = function()
					set(amount + step)
				end }
				list[i + 4] = { label = "−" .. step, disabled = amount <= 0, run = function()
					set(amount - step)
				end }
			end
			list[#DEAL_STEPS + 1] = { label = c:t("grid.all"), active = amount >= max, title = "×" .. max, run = function()
				set(max)
			end }
			list[panel.CONVERT] = {
				label = (if buying then c:t("grid.buy") else c:t("grid.sell")) .. " ×" .. amount,
				picture = c.protos.goods[resource],
				cost = amount * price,
				gain = not buying,
				disabled = amount < 1,
				title = if buying then c:t("grid.buyPrice", { price = price }) else c:t("grid.sellPrice", { price = price }),
				run = function()
					c:send(if buying then "buy" else "sell", { port = port, resource = resource, amount = amount })
					market.deal = nil
				end,
			}
			list[panel.BACK] = {
				label = c:t("common.back"),
				run = function()
					market.deal = nil
				end,
			}
		end
	else
		if order.total <= 0 and not order.buy then
			local delivered = math.floor(trade.delivered(c, port))
			list[panel.CANCEL] = {
				label = if delivered > 0 then c:t("grid.send") else c:t("grid.dropSale"),
				title = if delivered > 0 then c:t("grid.sendTip") else nil,
				run = function()
					c:send("closeSale", { port = port })
				end,
			}
		end
		list[panel.BACK] = {
			label = c:t("common.back"),
			run = function()
				open("root")
			end,
		}
	end
end


-- Космопорт — его сетка; не он — сделка забыта. Открытая страница торговли — не корень.
local function slots(c, list, view)
	local selection = view.selection
	local port = #selection == 1 and selection[1]
	local trading = port and c:mine(port) and trade.isPort(c, c.player, port)
	if trading then
		tradeSlots(c, list, port)
		if market.page ~= "root" then
			view.root = false
		end
	else
		market.port = -1
	end
end

local function info(c, view)
	local ui, first, text = c.ui, view.first, view.width
	if not (view.built and c:mine(first) and trade.isPort(c, c.player, first)) then
		return
	end
	local order = c:get(first, "Trade")
	if order then
		local name = c:t(c.protos.goods[order.resource].data.title)
		local wanted = math.floor(order.wanted + 0.5)
		local label, progress
		if order.buy then
			progress = 1 - order.left / order.total
			label = c:t("hud.buying", { name = name, wanted = wanted, paid = wanted * trade.buyPrice(c, order.resource) })
		elseif order.total > 0 then
			progress = 1 - order.left / order.total
			label = c:t("hud.shipping", { name = name, wanted = wanted, total = wanted * trade.price(c, order.resource) })
		else
			local delivered = math.floor(trade.delivered(c, first))
			progress = delivered / order.wanted
			label = c:t("hud.hauling", { name = name, delivered = delivered, wanted = wanted })
		end
		widgets.bar(ui, progress, label, text)
		return
	end
	local buying = market.page == "buy"
	local deal = market.port == first and (market.page == "sell" or buying) and market.deal and dealOf(c, first, buying, market.deal)
	if deal then
		ui:box({ direction = "row", align = "center", gap = 6 }, function()
			ui:text((if buying then c:t("grid.buy") else c:t("grid.sell")) .. ":", { color = COLORS.soft })
			goodWith(c, deal.resource, deal.amount, 20)
			local field = ui:input("deal", tostring(deal.amount), { width = 72, digits = true, maxLength = 6 })
			local amount = math.max(0, math.min(deal.max, math.floor(tonumber(field.value) or 0)))
			if amount ~= deal.amount then
				market.deal = { resource = deal.resource, amount = amount }
			end
			if table.find(field.keys, "Enter") and amount >= 1 then
				c:send(if buying then "buy" else "sell", { port = first, resource = deal.resource, amount = amount })
				market.deal = nil
			end
		end)
		-- В словаре это продолжение строки сделки (« — цена …»): здесь оно со своей строки.
		local note = if buying
			then c:t("hud.dealBuy", { total = deal.amount * deal.price, room = deal.room - deal.amount })
			else c:t("hud.dealSell", { total = deal.amount * deal.price, left = deal.max - deal.amount })
		ui:text(widgets.capital((string.gsub(note, "^[%s—]+", ""))), { color = COLORS.soft, wrap = text })
	else
		ui:text((if #offersOf(c, first) > 0
			then c:t("hud.sellHint")
			else c:t("hud.nothingToSell")) .. c:t("hud.buyHint"), { color = COLORS.soft, wrap = text })
	end
end

return {
	slots = { { at = 70, fill = slots } },
	info = { { at = 150, draw = info } },
}
