--!strict
-- Правила стройки из construction.ts и buildings.ts, общие хосту (ctx) и клиенту (c): что игроку открыто, где можно
-- заложить здание, сколько работы и кредитов уходит на стройку, разбор и починку, на каких стройках кредитов не
-- хватит. Как идёт работа — mechanics/construction.

local placement = require("lib/placement")
local zones = require("lib/zones")
local kinds = require("lib/kinds")
local conversion = require("lib/conversion")
local depositsLib = require("lib/deposits")

local construction = {}

-- Сколько кредитов цены вкладывает в секунду один строитель (BUILD_RATE): из цены считается время стройки.
construction.BUILD_RATE = 20
-- С какой доли прочности начинается недостроенное здание: ноль значил бы, что оно уже разбито (SITE_FLOOR).
construction.SITE_FLOOR = 0.02
-- Какую долю цены возвращает разбор готового здания и во сколько раз разбирать быстрее, чем строить.
construction.DEMOLISH_REFUND = 0.5
construction.DEMOLISH_SPEED = 1.5
-- Доля прочности обороны на песке (SAND_DURABILITY).
construction.SAND_DURABILITY = 0.7

-- Виды местности (terrain).
local SAND = 1

-- Math.round у JS: половина — вверх.
local function round(x: number): number
	return math.floor(x + 0.5)
end

-- Правила партии (data.rules) с числами по умолчанию (DEFAULT_RULES).
function construction.rules(w)
	local rules = w.game.data and w.game.data.rules or {}
	return {
		repairSpeed = rules.repairSpeed or 2,
		repairCost = rules.repairCost or 0.5,
		repairPause = rules.repairPause or 3,
		techTree = if rules.techTree == nil then true else rules.techTree,
	}
end

-- Сколько тиков работы одного строителя нужно на то, что стоит cost кредитов (workTicks).
function construction.workTicks(cost: number, dt: number): number
	return round(cost / construction.BUILD_RATE / dt)
end

-- Сколько тиков работы одного строителя нужно на здание вида kind (siteTicks).
function construction.siteTicks(kind, dt: number): number
	return construction.workTicks(kind.data.cost, dt)
end

-- Состояние игрока (Player) по номеру; нет — nil.
local function playerState(w, player: number)
	for _, e in w:each({ "Player" }) do
		local state = w:get(e, "Player")
		if state.id == player then
			return state
		end
	end
	return nil
end

function construction.credits(w, player: number): number
	local state = playerState(w, player)
	return if state then state.credits else 0
end

-- Своё и готовое: здание игрока, которое не строится и не разбирается (isReady).
function construction.isReady(w, player: number, e: number): boolean
	local owner = w:get(e, "Owner")
	return w:has(e, "Building") and w:has(e, "Footprint") and not w:has(e, "Site") and owner ~= nil and owner.player == player
end

-- Каких готовых зданий из списка needs у игрока нет — имена (missingBuildings).
function construction.missing(w, player: number, needs: { string }?): { string }
	if not needs or #needs == 0 then
		return {}
	end
	local have = {}
	for _, e in w:each({ "Building", "Owner" }) do
		local kind = kinds.of(w, e)
		if kind and not have[kind.name] and table.find(needs, kind.name) and construction.isReady(w, player, e) then
			have[kind.name] = true
		end
	end
	local missing = {}
	for _, name in needs do
		if not have[name] then
			table.insert(missing, name)
		end
	end
	return missing
end

-- Открыта ли игроку тема исследований: без темы и без дерева технологий — да. Исследований пока нет (В6): тема,
-- которой нет в Player.research, закрыта.
function construction.researched(w, player: number, topic: string?): boolean
	if topic == nil or not construction.rules(w).techTree then
		return true
	end
	local state = playerState(w, player)
	local known = state and state.research
	return type(known) == "table" and table.find(known, topic) ~= nil
end

-- Строят ли этот вид строители: у него есть место в меню (BUILDABLE).
function construction.buildable(kind): boolean
	return kind ~= nil and kind.data ~= nil and kind.data.menu ~= nil
end

-- Открыто ли игроку здание: строится строителями, все нужные для него здания стоят, исследование открыто (isUnlocked).
function construction.unlocked(w, player: number, kind): boolean
	if not construction.buildable(kind) then
		return false
	end
	if not construction.rules(w).techTree then
		return true
	end
	return #construction.missing(w, player, kind.data.requires) == 0 and construction.researched(w, player, kind.data.research)
end

-- Здания, которые строят строители, по порядку меню (BUILDABLE).
function construction.menu(w): { any }
	local list = {}
	for _, kind in w.protos.buildings do
		if construction.buildable(kind) then
			table.insert(list, kind)
		end
	end
	table.sort(list, function(a, b)
		return a.data.menu < b.data.menu
	end)
	return list
end

-- Нужна ли зданию своя зона: здание с собственной зоной начинает новую, оборону и трубы ставят где угодно, лишь бы не
-- в чужой зоне (needsZone).
function construction.needsZone(kind): boolean
	local data = kind.data
	return data.zone == nil and not data.defense and not data.pipe
end

-- Стоит ли стройка здесь без зоны: здание её требует, а в зоне игрока его нет (outOfControl).
function construction.outOfControl(w, player: number, kind, x: number, y: number, all: { [number]: { number } }?): boolean
	return construction.needsZone(kind) and not zones.inControl(w, player, x, y, kind.data.width, kind.data.height, all)
end

-- Остался ли запас в месторождении ровно под основанием с левым верхним тайлом (x, y) (reserveLeft).
local function reserveLeft(w, x: number, y: number): number
	local cx, cy = x + depositsLib.SIZE / 2, y + depositsLib.SIZE / 2
	for _, e in w:each({ "Deposit", "Position" }) do
		local at = w:get(e, "Position")
		if at.x == cx and at.y == cy then
			return w:get(e, "Deposit").reserve
		end
	end
	return 0
end

-- Может ли игрок заложить здание вида kind с левым верхним тайлом (x, y): оно открыто, место годится, лежит в своей
-- зоне (если она зданию нужна) и не задевает чужую; шахта — ровно на месторождение с запасом (canBuild).
function construction.canBuild(w, player: number, kind, x: number, y: number): boolean
	if not construction.unlocked(w, player, kind) or not placement.canPlace(w, kind, x, y) then
		return false
	end
	local all = zones.all(w)
	if zones.inForeign(w, player, x, y, kind.data.width, kind.data.height, all) then
		return false
	end
	if kind.data.extract and reserveLeft(w, x, y) <= 0 then
		return false
	end
	return not construction.outOfControl(w, player, kind, x, y, all)
end

-- Недостача материалов меньше этого считается погрешностью (MATERIAL_EPSILON).
construction.MATERIAL_EPSILON = 1e-6

-- Какую долю стройки позволяют привезённые материалы, от 0 до 1 (materialShare): дальше привезённого не строят.
-- Здание без материалов строится целиком; крошечная недостача считается привезённой.
function construction.materialShare(w, e: number): number
	local site = w:get(e, "Site")
	local kind = site and kinds.of(w, e)
	local materials = kind and kind.data.materials
	local stock = w:get(e, "Inventory")
	if not materials or not stock then
		return 1
	end
	local share = 1
	for good, amount in materials do
		local have = stock.items[good] or 0
		if have < amount - construction.MATERIAL_EPSILON then
			share = math.min(share, have / amount)
		end
	end
	return share
end

-- Стройка дошла до того, что позволяют привезённые материалы, и ждёт подвоза (awaitsMaterials).
function construction.awaitsMaterials(w, e: number): boolean
	local site = w:get(e, "Site")
	if not site or site.demolish then
		return false
	end
	local share = construction.materialShare(w, e)
	return share < 1 and site.progress >= site.total * share - 1e-9
end

-- Склад площадки под материалы (orderBuild): ровно столько, сколько их нужно.
function construction.siteStock(kind)
	local materials = kind.data.materials
	if not materials then
		return nil
	end
	local accepts, total = {}, 0
	for good, amount in materials do
		table.insert(accepts, good)
		total += amount
	end
	table.sort(accepts)
	return { items = {}, capacity = total, accepts = accepts, limits = table.clone(materials), reserve = 0 }
end

-- Дальше скольких тайлов протяжку не кладут разом (PAVE_LIMIT).
construction.STROKE_LIMIT = 400

-- Своя труба или колодец в тайле — готовые, строящиеся или заложенные (pipeAt); разбираемые — нет.
function construction.pipeAt(w, player: number, x: number, y: number): number?
	local e = w:occupant(x, y) or construction.siteAt(w, x, y)
	if not e then
		return nil
	end
	local owner = w:get(e, "Owner")
	local kind = kinds.of(w, e)
	local site = w:get(e, "Site")
	if not owner or owner.player ~= player or not kind or not kind.data.pipe or (site and site.demolish) then
		return nil
	end
	return e
end

-- Своя труба другого вида в тайле: новая ложится вместо неё (pipeSwap).
function construction.pipeSwap(w, player: number, kind, x: number, y: number): number?
	local e = construction.pipeAt(w, player, x, y)
	local other = e and kinds.of(w, e)
	return if other and other.name ~= kind.name then e else nil
end

-- Какие тайлы протянутой трубы или колодца можно заложить, по тайлу (pipeStroke): место годится под трубу или там своя
-- труба другого вида, и не в чужой зоне. Своя зона трубе не нужна.
function construction.pipeStroke(w, player: number, tiles: { number }, kind): { boolean }
	local taken = {}
	local allowed = {}
	local known = construction.researched(w, player, kind.data.research)
	local pipe = w.protos.buildings.pipe
	local all = zones.all(w)
	for i = 1, #tiles - 1, 2 do
		local x, y = tiles[i], tiles[i + 1]
		local key = x .. ":" .. y
		local fits = x == math.floor(x) and y == math.floor(y) and (placement.canPlace(w, pipe, x, y) or construction.pipeSwap(w, player, kind, x, y) ~= nil)
		local ok = known and not taken[key] and fits and not zones.inForeign(w, player, x, y, 1, 1, all)
		if ok then
			taken[key] = true
		end
		table.insert(allowed, ok)
	end
	return allowed
end

-- Какие тайлы протянутой стены или ворот можно заложить (wallStroke).
function construction.wallStroke(w, player: number, tiles: { number }, kind): { boolean }
	local taken = {}
	local allowed = {}
	for i = 1, #tiles - 1, 2 do
		local x, y = tiles[i], tiles[i + 1]
		local key = x .. ":" .. y
		local ok = x == math.floor(x) and y == math.floor(y) and not taken[key] and construction.canBuild(w, player, kind, x, y)
		if ok then
			taken[key] = true
		end
		table.insert(allowed, ok)
	end
	return allowed
end

-- Годятся ли тайлы концами подземного отрезка: два тайла на одной прямой, от 2 до UNDERGROUND_REACH (isWellPair).
function construction.isWellPair(tiles: { number }): boolean
	if #tiles ~= 4 then
		return false
	end
	local ax, ay, bx, by = tiles[1], tiles[2], tiles[3], tiles[4]
	local length = math.abs(bx - ax) + math.abs(by - ay)
	return (ax == bx or ay == by) and length >= 2 and length <= 10
end

-- Каким концам пары колодцев уже стоит свой колодец: такой конец не закладывают заново (wellsKept).
function construction.wellsKept(w, player: number, tiles: { number }): { boolean }
	local kept = {}
	for i = 1, #tiles - 1, 2 do
		local e = #tiles == 4 and construction.pipeAt(w, player, tiles[i], tiles[i + 1])
		local kind = e and kinds.of(w, e)
		table.insert(kept, kind ~= nil and kind ~= false and kind.name == "well")
	end
	return kept
end

-- Левый верхний тайл основания сущности.
function construction.corner(w, e: number): (number, number)
	local at = w:get(e, "Position")
	local size = w:get(e, "Building")
	return placement.left(at.x, size.width), placement.left(at.y, size.height)
end

-- Стройка или разбор на тайле (x, y): сущность с Site, чьё основание его накрывает (siteAt); нет — nil.
function construction.siteAt(w, x: number, y: number): number?
	for _, e in w:each({ "Site", "Building", "Position" }) do
		local size = w:get(e, "Building")
		local left, top = construction.corner(w, e)
		if x >= left and x < left + size.width and y >= top and y < top + size.height then
			return e
		end
	end
	return nil
end

-- Сколько стройке осталось доплатить: цена за вычетом построенной доли; разбор не платит.
local function owed(w, e: number): number
	local site = w:get(e, "Site")
	local kind = kinds.of(w, e)
	if not kind or site.demolish then
		return 0
	end
	return kind.data.cost * math.max(0, 1 - site.progress / site.total)
end

-- Свободные кредиты: на счету за вычетом того, что игрок ещё доплатит за свои стройки (freeCredits).
function construction.freeCredits(w, player: number): number
	local total = 0
	for _, e in w:each({ "Site", "Owner" }) do
		if w:get(e, "Owner").player == player then
			total += owed(w, e)
		end
	end
	return construction.credits(w, player) - total
end

-- Свои стройки, которым не хватит кредитов на счету: кредиты раздаются по порядку закладки, каждой — на остаток её
-- цены (sitesShortOfCredits). Так значок «ждёт кредитов» не мигает, пока доход приносит кредит, а стройка его тратит.
function construction.short(w, player: number): { [number]: boolean }
	local short = {}
	local budget = construction.credits(w, player)
	for _, e in w:each({ "Site", "Owner" }) do
		if w:get(e, "Owner").player ~= player or w:get(e, "Site").demolish then
			continue
		end
		local left = owed(w, e)
		if budget >= left then
			budget -= left
		else
			short[e] = true
		end
	end
	return short
end

-- Доля готовности стройки от 0 до 1.
function construction.progress(w, e: number): number
	local site = w:get(e, "Site")
	if not site then
		return 1
	end
	return math.min(1, site.progress / site.total)
end

-- Сколько кредитов вернёт разбор здания вида kind: доля его цены (refundOf). Уровней пока нет.
function construction.refundOf(kind): number
	return math.floor(kind.data.cost * construction.DEMOLISH_REFUND)
end

-- Сколько кредитов здание держит оплаченными вперёд: очередь юнитов (prepaidOf). Разбор их возвращает.
function construction.prepaidOf(w, e: number): number
	local producer = w:get(e, "Producer")
	if not producer then
		return 0
	end
	local paid = 0
	for _, name in { producer.unit, table.unpack(producer.queue) } do
		local unit = w.protos.units[name]
		if unit then
			paid += unit.data.cost
		end
	end
	return paid
end

-- Может ли игрок разобрать здание: своё, готовое и не главное — главное сворачивают в MCV (canDemolish).
function construction.canDemolish(w, player: number, e: number): boolean
	if not construction.isReady(w, player, e) or w:has(e, "Converting") then
		return false
	end
	return not kinds.is(w, e, conversion.building(w))
end

-- Можно ли это чинить: готовое повреждённое здание или юнит, чья прочность чинится (isRepairable).
function construction.isRepairable(w, e: number): boolean
	if construction.rules(w).repairSpeed <= 0 then
		return false
	end
	local health = w:get(e, "Health")
	return health ~= nil and health.repairable and health.value < health.max and not w:has(e, "Site") and not w:has(e, "Converting")
end

-- Может ли игрок послать строителей чинить это (canRepair).
function construction.canRepair(w, player: number, e: number): boolean
	local owner = w:get(e, "Owner")
	return owner ~= nil and owner.player == player and construction.isRepairable(w, e)
end

-- Сколько кредитов стоит дочинить: share — доля цены за починку с нуля (repairCostOf).
function construction.repairCostOf(cost: number, health: number, share: number, max: number?): number
	return math.ceil(cost * share * ((max or 1) - health))
end

-- Предел прочности здания на этом месте: оборона на песке без фундамента — SAND_DURABILITY (durabilityOf).
function construction.durabilityOf(w, kind, x: number, y: number): number
	if not kind.data.defense then
		return 1
	end
	for tileY = y, y + kind.data.height - 1 do
		for tileX = x, x + kind.data.width - 1 do
			if w:terrain(tileX, tileY) == SAND then
				return construction.SAND_DURABILITY
			end
		end
	end
	return 1
end

return construction
