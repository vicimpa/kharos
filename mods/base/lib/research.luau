--!strict
-- Темы исследований — перенос topics.ts, общий хосту (ctx) и клиенту (c). Тема — вид раздела research/: что нужно
-- раньше (after), что тратит (uses), открытие ли (trigger). Тема тратит то, из чего делают открываемое; чем глубже она
-- в дереве, тем дороже и дольше: ярус — на единицу глубже самого глубокого предшественника, каждый ярус умножает цену и
-- срок на researchGrowth. Темы-открытия лаборатории не ведут: они открываются сами (mechanics/research).
--
-- У игрока (Player): research — открытые темы по порядку, plan — очередь, progress — доля начатых, topic — тема,
-- которую лаборатории ведут сейчас (её выбирает хост: головная или та, что её подменяет без сырья).

local kinds = require("lib/kinds")

local research = {}

-- Цена темы первого яруса и её срок в секундах работы одной лаборатории при полной энергии (TIER_CREDITS,
-- TIER_SECONDS).
research.TIER_CREDITS = 100
research.TIER_SECONDS = 20

-- Темп исследований из правил партии (researchScale, researchGrowth, researchSlow).
function research.rules(w)
	local rules = w.game.data and w.game.data.rules or {}
	return { scale = rules.researchScale or 1, growth = rules.researchGrowth or 1.6, slow = rules.researchSlow or 1 }
end

-- Все темы по порядку (TOPICS).
local cache = setmetatable({}, { __mode = "k" }) :: { [any]: { any } }

function research.list(w): { any }
	local found = cache[w.protos]
	if found then
		return found
	end
	found = {}
	for _, kind in w.protos.research or {} do
		table.insert(found, kind)
	end
	table.sort(found, function(a, b)
		return a.data.order < b.data.order
	end)
	cache[w.protos] = found
	return found
end

function research.topic(w, name: string)
	return (w.protos.research or {})[name]
end

function research.isTrigger(w, name: string): boolean
	local kind = research.topic(w, name)
	return kind ~= nil and kind.data.trigger ~= nil
end

-- Ярус темы (tierOf): 1 — без предшественников; открытия сложности не добавляют.
local tiers = setmetatable({}, { __mode = "k" }) :: { [any]: { [string]: number } }

function research.tier(w, name: string): number
	local known = tiers[w.protos]
	if not known then
		known = {}
		tiers[w.protos] = known
	end
	local found = known[name]
	if found then
		return found
	end
	local deepest = 0
	for _, before in research.topic(w, name).data.after or {} do
		if not research.isTrigger(w, before) then
			deepest = math.max(deepest, research.tier(w, before))
		end
	end
	known[name] = 1 + deepest
	return 1 + deepest
end

export type Price = { cost: number, materials: { [string]: number }, seconds: number }

-- Что тема стоит целиком (priceOf): кредиты, сырьё и секунды работы одной лаборатории.
function research.price(w, name: string): Price
	if research.isTrigger(w, name) then
		return { cost = 0, materials = {}, seconds = 0 }
	end
	local rules = research.rules(w)
	local factor = rules.growth ^ (research.tier(w, name) - 1)
	local materials = {}
	for good, amount in research.topic(w, name).data.uses or {} do
		materials[good] = math.floor(amount * factor * rules.scale + 0.5)
	end
	return { cost = math.floor(research.TIER_CREDITS * factor * rules.scale + 0.5), materials = materials, seconds = research.TIER_SECONDS * factor * rules.slow }
end

-- Состояние игрока (Player) по номеру.
function research.player(w, player: number)
	for _, e in w:each({ "Player" }) do
		local state = w:get(e, "Player")
		if state.id == player then
			return state, e
		end
	end
	return nil, nil
end

-- Открыта ли тема игроку; без дерева технологий открыто всё (hasResearch).
function research.has(w, player: number, name: string?): boolean
	if name == nil then
		return true
	end
	local rules = w.game.data and w.game.data.rules or {}
	if rules.techTree == false then
		return true
	end
	local state = research.player(w, player)
	return state ~= nil and table.find(state.research or {}, name) ~= nil
end

-- Темы, которые надо исследовать, чтобы открыть эту, вместе с ней, предшественники раньше (pathTo).
function research.pathTo(w, name: string, done: { string }): { string }
	local path = {}
	local function visit(next: string)
		if table.find(done, next) or table.find(path, next) then
			return
		end
		for _, before in research.topic(w, next).data.after or {} do
			visit(before)
		end
		table.insert(path, next)
	end
	visit(name)
	return path
end

-- Все предшественники темы вглубь (topicsUnder).
function research.under(w, name: string): { [string]: boolean }
	local found = {}
	local function visit(next: string)
		for _, before in research.topic(w, next).data.after or {} do
			if not found[before] then
				found[before] = true
				visit(before)
			end
		end
	end
	visit(name)
	return found
end

-- Темы плана, которые можно вести сейчас, в порядке плана (openTopics).
function research.open(w, player: number): { string }
	local state = research.player(w, player)
	if not state then
		return {}
	end
	local known = state.research or {}
	local list = {}
	for _, name in state.plan or {} do
		local kind = research.topic(w, name)
		if not kind or table.find(known, name) then
			continue
		end
		local ready = true
		for _, before in kind.data.after or {} do
			if not table.find(known, before) then
				ready = false
			end
		end
		if ready then
			table.insert(list, name)
		end
	end
	return list
end

-- Тема, которую лаборатории игрока ведут сейчас (currentTopic): выбранная хостом, если она ещё открыта, иначе головная.
function research.current(w, player: number): string?
	local open = research.open(w, player)
	local state = research.player(w, player)
	local pick = state and state.topic
	if pick and pick ~= "" and table.find(open, pick) then
		return pick
	end
	return open[1]
end

-- Сколько чего ещё потратят нынешняя тема и головная, если ведут не её (researchNeeds).
function research.needs(w, player: number): { [string]: number }
	local current = research.current(w, player)
	if not current then
		return {}
	end
	local state = research.player(w, player)
	local progress = state.progress or {}
	local needs = {}
	local topics = { research.open(w, player)[1] }
	if current ~= topics[1] then
		table.insert(topics, current)
	end
	for _, name in topics do
		local left = 1 - (progress[name] or 0)
		for good, amount in research.price(w, name).materials do
			needs[good] = (needs[good] or 0) + amount * left
		end
	end
	return needs
end

-- Что открывает тема: здания и юниты (unlockedBy).
function research.unlocks(w, name: string): ({ any }, { any })
	local buildings, units = {}, {}
	for _, kind in w.protos.buildings do
		if kind.data.research == name then
			table.insert(buildings, kind)
		end
	end
	for _, kind in w.protos.units do
		if kind.data.research == name then
			table.insert(units, kind)
		end
	end
	table.sort(buildings, function(a, b)
		return (a.data.menu or 999) < (b.data.menu or 999)
	end)
	table.sort(units, function(a, b)
		return a.name < b.name
	end)
	return buildings, units
end

-- Лаборатория ли это игрока: готовая и своя (isLab).
function research.isLab(w, player: number, e: number): boolean
	local owner = w:get(e, "Owner")
	if not owner or owner.player ~= player or not w:has(e, "Building") or w:has(e, "Site") then
		return false
	end
	local kind = kinds.of(w, e)
	return kind ~= nil and kind.data.researches == true
end

return research
