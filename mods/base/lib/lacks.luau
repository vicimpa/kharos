--!strict
-- Чего ждут свои здания, которые из-за этого стоят: каждому — первый недостающий груз (или "credits"). Стройка,
-- дошедшая до привезённого, — материала, а у которой материалы есть, но на остаток цены кредитов не хватит, — кредитов;
-- производитель, чей заказ не из чего начать; включённый цех без сырья на сборку; лаборатория без сырья темы; турель,
-- которой нечем выстрелить, и реактор без стержней. Чего не хватает зданию, которое и не должно работать — выключено,
-- нет заказа, — не считается: это не тревога. О чужих судить не по чему: их склады знает только хозяин. По этому над
-- зданием рисуется значок (effects/power).

local construction = require("lib/construction")
local economy = require("lib/economy")
local goods = require("lib/goods")
local logistics = require("lib/logistics")

local lacks = {}

local EPSILON = 1e-6
-- Стержень реактор сжигает целиком: меньше одного — не горит.
local ROD = 1

-- Первый по порядку грузов из недостающего.
local function firstOf(w, amounts: { [string]: number }): string?
	for _, name in goods.names(w) do
		if amounts[name] then
			return name
		end
	end
	return nil
end

-- Есть ли у турели здания чем выстрелить хоть одним стволом, у реактора — стержень (fed).
function lacks.fed(w, e: number, data): boolean
	local stock = w:get(e, "Inventory")
	if not data.ammo then
		return not data.burns or goods.amount(stock, data.burns.good) >= ROD - EPSILON
	end
	local have = goods.amount(stock, "ammo")
	for _, mount in data.mounts or {} do
		local turret = w.protos.turrets[mount.turret]
		local weapon = turret and turret.data.weapon and w.protos.weapons[turret.data.weapon]
		if not weapon or have >= (weapon.data.ammo or 0) - 1e-9 then
			return true
		end
	end
	return false
end

-- Чего ждут свои здания игрока player: здание → груз или "credits".
function lacks.of(w, player: number): { [number]: string }
	local found: { [number]: string } = {}
	local function own(e: number): boolean
		local owner = w:get(e, "Owner")
		return owner ~= nil and owner.player == player
	end
	local function stands(e: number): boolean
		return own(e) and not economy.shutDown(w, player, e)
	end
	local broke = construction.short(w, player)
	for _, e in w:each({ "Site" }) do
		if not own(e) or w:get(e, "Site").demolish then
			continue
		end
		if construction.awaitsMaterials(w, e) then
			found[e] = firstOf(w, logistics.missing(w, e)) :: any
		elseif broke[e] then
			found[e] = "credits"
		end
	end
	for _, e in w:each({ "Producer" }) do
		local producer = w:get(e, "Producer")
		if #producer.queue == 0 or producer.progress > 0 or w:has(e, "Site") or w:has(e, "Converting") or not stands(e) then
			continue
		end
		found[e] = firstOf(w, logistics.missing(w, e)) :: any
	end
	for _, e in w:each({ "Assembly", "Inventory" }) do
		local assembly = w:get(e, "Assembly")
		local product = w.protos.goods[assembly.recipe]
		if not product or not assembly.on or assembly.progress > 0 or w:has(e, "Site") or not own(e) then
			continue
		end
		local stock = w:get(e, "Inventory")
		-- Готовому некуда лечь — это не нехватка сырья.
		if goods.room(stock, assembly.recipe) < product.data.yield - EPSILON then
			continue
		end
		for _, name in goods.names(w) do
			local amount = product.data.recipe[name]
			if amount and goods.amount(stock, name) < amount - EPSILON then
				found[e] = name
				break
			end
		end
	end
	for _, e in w:each({ "Research" }) do
		local lack = w:get(e, "Research").lack
		if stands(e) and w.protos.goods[lack] then
			found[e] = lack
		end
	end
	for _, e in w:each({ "Building", "Inventory" }) do
		local data = logistics.dataOf(w, e)
		local feed = logistics.feedOf(data)
		if feed and not w:has(e, "Site") and stands(e) and not lacks.fed(w, e, data) then
			found[e] = feed
		end
	end
	return found
end

-- Свои турели и реакторы, у которых запаса меньше AMMO_REORDER, но он ещё не кончился: над ними значок груза бледный —
-- тревога заранее.
function lacks.low(w, player: number): { [number]: string }
	local low: { [number]: string } = {}
	for _, e in w:each({ "Building", "Inventory" }) do
		local data = logistics.dataOf(w, e)
		local feed = logistics.feedOf(data)
		local owner = w:get(e, "Owner")
		if not feed or w:has(e, "Site") or not owner or owner.player ~= player or economy.shutDown(w, player, e) then
			continue
		end
		local stock = w:get(e, "Inventory")
		local have = goods.amount(stock, feed)
		local share = have / (have + goods.room(stock, feed))
		if share < logistics.AMMO_REORDER and lacks.fed(w, e, data) then
			low[e] = feed
		end
	end
	return low
end

return lacks
