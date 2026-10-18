--!strict
-- Уровни зданий — перенос levelFactor, levelGain, upgradeCost из buildings.ts и upgrades.ts. Шахту, переработку,
-- хранилище, космопорт, электростанцию и радар поднимают до MAX_LEVEL: каждый уровень прибавляет LEVEL_BONUS к тому,
-- что здание делает. Цена — кредиты и готовое: стройблоки, выше — ещё и компоненты. Списывается она сразу при заказе,
-- и готовое берётся со складов энергосети здания — сначала его сети труб, потом сетей, задевших её зоной: как энергия,
-- электростанции труба ни к чему. Работу делают строители, как стройку (mechanics/construction); здание всё это время
-- работает. Второй и третий уровни открывают исследования levels2 и levels3.

local kinds = require("lib/kinds")
local logistics = require("lib/logistics")
local research = require("lib/research")
local wallet = require("lib/wallet")
local goods = require("lib/goods")

local levels = {}

-- Выше этого уровня здания не улучшают.
levels.MAX_LEVEL = 3
-- На какую долю от первого уровня каждый следующий поднимает то, что здание делает: второй — в полтора раза, третий —
-- вдвое.
levels.LEVEL_BONUS = 0.5
-- Какую долю цены здания стоит в кредитах подъём с первого уровня; с каждого следующего — на столько же больше.
local UPGRADE_SHARE = 0.5
-- На сколько кредитов цены здания идёт один стройблок за уровень и один компонент на верхних уровнях.
local UPGRADE_BLOCKS = 30
local UPGRADE_PARTS = 60

-- Math.round у JS: половина — вверх.
local function round(x: number): number
	return math.floor(x + 0.5)
end

-- Во сколько раз здание этого уровня сильнее первого (levelFactor).
function levels.factor(level: number): number
	return 1 + levels.LEVEL_BONUS * (level - 1)
end

-- Уровень здания; у стройки и у того, что не здание, — первый (levelOf).
function levels.of(w, e: number): number
	local building = w:get(e, "Building")
	return if building and building.level then building.level else 1
end

-- Во сколько раз это здание сильнее первого уровня.
function levels.factorOf(w, e: number): number
	return levels.factor(levels.of(w, e))
end

-- Что уровень поднимает у здания вида kind (levelGain): "extract" — добычу, "refine" — скорость переработки, "store" —
-- ёмкость, "trade" — трюм и скорость рейсов, "scan" — радиус разведки (и потребление), "power" — выработку; nil — его
-- не улучшают. Реактор не улучшают: выработка с уровнем росла бы, а расход стержней — нет.
function levels.gain(kind): string?
	local data = kind and kind.data
	if not data then
		return nil
	end
	if data.extract then
		return "extract"
	elseif data.refines then
		return "refine"
	elseif data.stores then
		return "store"
	elseif data.trades then
		return "trade"
	elseif data.scan then
		return "scan"
	end
	return if (data.power or 0) > 0 and not data.burns then "power" else nil
end

-- Как это называется в строке «Уровень 2 из 3: … ×1,5» (levelGains в ru.json).
levels.GAINS = {
	extract = "добыча",
	refine = "скорость переработки",
	store = "ёмкость",
	trade = "трюм и скорость рейсов",
	power = "выработка",
	scan = "радиус разведки (и потребление)",
}

-- Во сколько раз уровни дороже и дольше, чем в матче (Rules.upgradeScale).
function levels.scale(w): number
	local rules = w.game and w.game.data and w.game.data.rules or {}
	return rules.upgradeScale or 1
end

export type Cost = { credits: number, materials: { [string]: number } }

-- Цена подъёма здания вида kind с уровня level на следующий (upgradeCost): стройблоки нужны всегда, с третьего уровня
-- — ещё и компоненты: первый подъём по силам базе с одним цехом, дальше нужна вся цепочка изделий. scale — во сколько
-- раз дороже по правилам мира.
function levels.cost(kind, level: number, scale: number?): Cost
	local cost = kind.data.cost
	local times = scale or 1
	local materials = { blocks = math.ceil(math.ceil(cost / UPGRADE_BLOCKS) * level * times) }
	if level >= 2 then
		materials.parts = math.ceil(math.ceil(cost / UPGRADE_PARTS) * (level - 1) * times)
	end
	return { credits = round(cost * UPGRADE_SHARE * level * times), materials = materials }
end

-- Сколько кредитов вложено в уровни здания сверх его цены — по цене матча (upgradeSpent): по какой цене поднимали на
-- самом деле, здание не помнит. Разбор возвращает долю этого.
function levels.spent(kind, level: number): number
	local spent = 0
	for below = 1, level - 1 do
		spent += levels.cost(kind, below).credits
	end
	return spent
end

-- Какое исследование открывает подъём здания с уровня level (levelTopic).
function levels.topic(level: number): string
	return if level >= 2 then "levels3" else "levels2"
end

-- Склад хранилища и трюм космопорта с уровнем вмещают больше (applyLevel). level — новый уровень, если он ещё не
-- записан (ctx:set откладывается до конца системы).
function levels.apply(w, e: number, level: number?)
	local kind = kinds.of(w, e)
	local stock = w:get(e, "Inventory")
	if not kind or not stock or not kind.data.inventory or not (kind.data.stores or kind.data.trades) then
		return
	end
	w:set(e, "Inventory", { capacity = round(kind.data.inventory * levels.factor(level or levels.of(w, e))) })
end

-- Поднимают ли это здание игрока сейчас (isUpgradable): своё, готовое, из тех, что улучшают, не на верхнем уровне,
-- не разворачивается и не улучшается.
function levels.upgradable(w, player: number, e: number): boolean
	if not logistics.isReady(w, player, e) or w:has(e, "Converting") or w:has(e, "Upgrade") then
		return false
	end
	return levels.gain(kinds.of(w, e)) ~= nil and levels.of(w, e) < levels.MAX_LEVEL
end

-- Чего не хватает на следующий уровень здания (upgradeLack): "research", "credits" или "materials" — готового в его
-- энергосети; nil — всего хватает.
function levels.lack(w, player: number, e: number): string?
	local kind = kinds.of(w, e)
	if not kind or not w:has(e, "Building") then
		return nil
	end
	local level = levels.of(w, e)
	if not research.has(w, player, levels.topic(level)) then
		return "research"
	end
	local price = levels.cost(kind, level, levels.scale(w))
	if wallet.credits(w, player) < price.credits then
		return "credits"
	end
	return if logistics.networkHas(w, e, price.materials, true) then nil else "materials"
end

-- Заказывает следующий уровень своего готового здания (orderUpgrade): кредиты и готовое списываются сразу, готовое —
-- со складов энергосети здания, сначала из хранилищ. Возвращает, принят ли заказ.
function levels.order(ctx, player: number, e: number): boolean
	if not levels.upgradable(ctx, player, e) or levels.lack(ctx, player, e) then
		return false
	end
	local scale = levels.scale(ctx)
	local price = levels.cost(kinds.of(ctx, e), levels.of(ctx, e), scale)
	if not wallet.pay(ctx, player, price.credits) then
		return false
	end
	local w = goods.book(ctx, { "Inventory" })
	logistics.takeFromNetwork(w, e, price.materials, true)
	w:flush()
	ctx:add(e, "Upgrade", { progress = 0, scale = scale })
	return true
end

-- Отменяет улучшение (cancelUpgrade): кредиты возвращаются целиком, готовое — в хранилища энергосети здания, а чему там
-- нет места — на землю у здания. Вложенная работа пропадает.
function levels.cancel(ctx, player: number, e: number): boolean
	local upgrade = ctx:get(e, "Upgrade")
	local kind = kinds.of(ctx, e)
	if not upgrade or not kind or not logistics.isReady(ctx, player, e) then
		return false
	end
	local price = levels.cost(kind, levels.of(ctx, e), upgrade.scale)
	ctx:remove(e, "Upgrade")
	wallet.refund(ctx, player, price.credits)
	local w = goods.book(ctx, { "Inventory" })
	logistics.returnToNetwork(w, e, price.materials, true)
	w:flush()
	return true
end

-- Значок модернизации (levelCanvas в portraits.ts): корпус здания и над ним шевроны цвета команды, по одному на
-- уровень, до которого исследование поднимает. Рисунок 32×32.
function levels.drawIcon(g, level: number)
	local INK = 0x0b111b
	-- Корпус с окнами.
	g:rect(5, 17, 22, 14, INK)
	g:rect(6, 18, 20, 12, 0x2d4560)
	g:rect(6, 18, 20, 1, 0x6184a3)
	g:rect(6, 27, 20, 3, 0x1c2b3e)
	for _, x in { 8, 14, 20 } do
		g:rect(x, 21, 4, 3, 0x5aa9ff)
	end
	-- Шевроны вверх: нижний — тусклее, верхний — ярче.
	local colors = { 0x1f63d8, 0x5aa9ff, 0xe4f4ff }
	for i = 0, level - 1 do
		local y = 14 - i * 5
		local color = colors[math.min(#colors, i + 4 - level)]
		g:line(9, y + 4, 16, y - 2, 4, INK)
		g:line(16, y - 2, 23, y + 4, 4, INK)
		g:line(9, y + 4, 16, y - 2, 2, color)
		g:line(16, y - 2, 23, y + 4, 2, color)
	end
end

return levels
