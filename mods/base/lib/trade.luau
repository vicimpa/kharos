--!strict
-- Торговля с орбиты, общий хосту и клиенту. Космопорт (data.trades) продаёт ресурсы из хранилищ игрока: товар заявки
-- свозят в его трюм, и когда привезено всё, корабль улетает и через sellSeconds приносит кредиты по цене ресурса.
-- Закупка — втридорога: кредиты сразу, груз прилетает через buySeconds в склад космопорта. Корабль у космопорта один:
-- пока он в пути, новую сделку не начать.

local economy = require("lib/economy")
local goods = require("lib/goods")
local logistics = require("lib/logistics")
local research = require("lib/research")
local levels = require("lib/levels")
local world = require("lib/world")

local trade = {}

-- Сколько секунд летит корабль с продажей и с закупкой; во сколько раз закупка дороже продажи: лишнее продаётся по
-- цене, недостающее покупается втридорога — тупика нет, но своя добыча всегда выгоднее.
trade.SELL_SECONDS = 20
trade.BUY_SECONDS = trade.SELL_SECONDS
trade.BUY_MARKUP = 3

-- Ресурс ли это (не изделие и не руда).
function trade.isResource(w, name: string): boolean
	local kind = w.protos.goods[name]
	return kind ~= nil and kind.data.kind == "resource"
end

-- Продаётся ли ресурс с орбиты: добываемый только (data.mined, уран) — нет.
function trade.isOrbital(w, name: string): boolean
	return trade.isResource(w, name) and not w.protos.goods[name].data.mined
end

-- Почём продаётся единица ресурса и почём её купить с орбиты.
function trade.price(w, name: string): number
	return w.protos.goods[name].data.price or 0
end

function trade.buyPrice(w, name: string): number
	return trade.price(w, name) * trade.BUY_MARKUP
end

-- Какую тему игроку надо изучить, чтобы купить ресурс с орбиты; nil — ничего не надо.
function trade.buyResearch(w, player: number, name: string): string?
	local topic = w.protos.goods[name].data.research
	return if research.has(w, player, topic) then nil else topic
end

-- Сколько тиков летит корабль к космопорту port: с уровнем порта — быстрее.
function trade.flightTicks(w, port: number, seconds: number): number
	return math.floor(seconds / levels.factorOf(w, port) / w.dt + 0.5)
end

-- Свой готовый космопорт игрока.
function trade.isPort(w, player: number, port: number): boolean
	return logistics.dataOf(w, port).trades == true and world.isReady(w, player, port)
end

-- Может ли игрок торговать через космопорт: свой, готовый, включённый и корабль не в деле. Подарков союзникам кораблём (Transfer)
-- пока нет — они придут с союзами.
function trade.canSell(w, player: number, port: number): boolean
	return trade.isPort(w, player, port) and not w:has(port, "Trade") and not economy.switchedOff(w, port)
end

-- Сколько товара заявки уже привезли в космопорт: он лежит в его складе.
function trade.delivered(w, port: number): number
	local order = w:get(port, "Trade")
	if not order or order.buy then
		return 0
	end
	local stock = w:get(port, "Inventory")
	return if stock then math.min(order.wanted, goods.amount(stock, order.resource)) else 0
end

-- Что лежит в хранилищах сети.
function trade.stockOfZone(w, network): { [string]: number }
	local items = {}
	for _, e in network.members do
		local stock = w:get(e, "Inventory")
		if stock and logistics.isStore(w, e) then
			for good, amount in stock.items do
				if amount > 0 then
					items[good] = (items[good] or 0) + amount
				end
			end
		end
	end
	return items
end

return trade
