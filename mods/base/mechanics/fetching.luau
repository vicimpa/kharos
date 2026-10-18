--!strict
-- Строители сами возят материалы. Стройка, которой не хватает материалов, встаёт, когда построено всё, что позволяет
-- привезённое; если недостающее никто не везёт, её строитель едет к ближайшему своему зданию, которое его отдаёт, берёт
-- лучом, сколько поместится, и сгружает на площадку. Так первую базу строят без грузовиков.
--
-- Поручение (Fetch) живёт, пока строитель на этой стройке: увели — бросает, груз остаётся в кузове. Остаток в кузове
-- свободного строителя едет в ближайшее хранилище. Что строитель везёт, учитывают заявки (lib/logistics).

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local construction = require("lib/construction")
local approach = require("lib/approach")
local beams = require("lib/beam")
local world = require("lib/world")

local mechanic = {}

local NONE = -1
local EPSILON = goods.EPSILON

mechanic.data = {
	-- Раз во сколько тиков строитель ищет, где взять материал, и пробует подъехать снова; после скольких промахов
	-- подряд бросает поручение.
	retryTicks = 20,
	giveUp = 3,
}

mechanic.components = {
	-- Поручение строителя: набрать до amount груза resource у from (NONE — уже в кузове) и сгрузить на to; full — набрал.
	Fetch = { from = -1, to = -1, resource = "", amount = 0, full = false, misses = 0 },
}

-- Что в кузове: первый груз по порядку.
local function cargoOf(w, builder: number): string?
	local cargo = w:get(builder, "Inventory")
	if not cargo then
		return nil
	end
	for _, name in goods.names(w) do
		if goods.amount(cargo, name) > EPSILON then
			return name
		end
	end
	return nil
end

-- Ближайшее своё готовое хранилище, куда поместится груз: туда свободный строитель отвозит остаток.
local function storeFor(w, builder: number, good: string): number?
	local player = w:get(builder, "Owner").player
	local at = w:get(builder, "Position")
	local best, bestDistance = nil, math.huge
	for _, e in w:each({ "Building", "Owner", "Inventory" }) do
		if not world.isReady(w, player, e) or not logistics.isStore(w, e) or goods.room(w:get(e, "Inventory"), good) < logistics.MIN_FETCH then
			continue
		end
		local there = w:get(e, "Position")
		local distance = math.sqrt((there.x - at.x) ^ 2 + (there.y - at.y) ^ 2)
		if distance < bestDistance then
			best, bestDistance = e, distance
		end
	end
	return best
end

-- Подводит строителя к складу на длину луча; не вышло giveUp раз подряд — бросает поручение.
local function goTo(w, builder: number, fetch, target: number)
	if w:has(builder, "Path") then
		return
	end
	if fetch.misses > 0 and not world.onTurn(w, builder, mechanic.data.retryTicks) then
		return
	end
	fetch.misses = if approach.go(w, builder, target, w:get(builder, "Beam").radius) then 0 else fetch.misses + 1
	if fetch.misses >= mechanic.data.giveUp then
		w:remove(builder, "Fetch")
	end
end

-- Один тик поручения: набрать груз у from, довезти и сгрузить на to.
local function run(w, builder: number, fetch)
	local to = fetch.to
	local toSite = w:alive(to) and w:has(to, "Site")
	local builds = w:get(builder, "Builds")
	-- На стройку везут, пока строитель на ней; в хранилище — пока ему не дали работу.
	if not w:alive(to) or not w:has(to, "Inventory") or (if toSite then (not builds or builds.site ~= to) else builds ~= nil) then
		w:remove(builder, "Fetch")
		return
	end
	local cargo = w:get(builder, "Inventory")
	local have = goods.amount(cargo, fetch.resource)
	if not fetch.full then
		local from = fetch.from
		local want = fetch.amount - have
		local gone = from == NONE or not w:alive(from) or not w:has(from, "Inventory") or w:has(from, "Site")
		if not gone and want > EPSILON then
			if not beams.reaches(w, from, builder) then
				goTo(w, builder, fetch, from)
				return
			end
			local moved = beams.transfer(w, from, builder, fetch.resource, math.min(want, logistics.given(w, from, fetch.resource)))
			if moved > EPSILON then
				w:stop(builder)
				return
			end
		end
		-- Набрал, сколько хотел, или больше не дают: едет с тем, что есть.
		if have <= EPSILON then
			w:remove(builder, "Fetch")
			return
		end
		fetch.full = true
	end
	if have <= EPSILON then
		w:remove(builder, "Fetch")
		return
	end
	if not beams.reaches(w, builder, to) then
		goTo(w, builder, fetch, to)
		return
	end
	local need = if toSite then (logistics.missing(w, to)[fetch.resource] or 0) else math.huge
	-- Сгрузил всё, стройке больше не нужно или класть некуда — поручение кончено.
	if need <= EPSILON or beams.transfer(w, builder, to, fetch.resource, need) <= EPSILON or goods.amount(cargo, fetch.resource) <= EPSILON then
		w:remove(builder, "Fetch")
	end
end

mechanic.systems = {
	-- После грузовиков: что везут они, строители не повезут.
	fetch = {
		after = { "haul" },
		before = { "fight" },
		run = function(_, ctx)
			local w = goods.book(ctx, { "Inventory", "Beam", "Fetch" })
			local flows = nil
			for _, builder in ctx:each({ "Unit", "Repair", "Inventory", "Beam" }) do
				if ctx:has(builder, "Converting") then
					continue
				end
				local fetch = w:get(builder, "Fetch")
				if fetch then
					run(w, builder, fetch)
					continue
				end
				local cargo = cargoOf(w, builder)
				local builds = ctx:get(builder, "Builds")
				local site = builds and builds.site
				if site and ctx:alive(site) and ctx:has(site, "Site") then
					if cargo then
						-- Материал, нужный стройке, уже в кузове — везёт сразу.
						if (logistics.missing(w, site)[cargo] or 0) > EPSILON then
							ctx:add(builder, "Fetch", { from = NONE, to = site, resource = cargo, amount = goods.amount(w:get(builder, "Inventory"), cargo), full = true })
						end
						continue
					end
					if not world.onTurn(ctx, builder, mechanic.data.retryTicks) or not construction.awaitsMaterials(w, site) then
						continue
					end
					flows = flows or logistics.flows(w)
					local source = logistics.fetchSource(w, builder, site, flows)
					if not source then
						continue
					end
					ctx:add(builder, "Fetch", { from = source.from, to = site, resource = source.resource, amount = source.amount, full = false })
					ctx:stop(builder)
					-- Следующему строителю — с учётом того, что повезёт этот.
					logistics.add(flows.outgoing, source.from, source.resource, source.amount)
					logistics.add(flows.incoming, site, source.resource, source.amount)
					continue
				end
				if not cargo or builds or ctx:has(builder, "Path") or not world.onTurn(ctx, builder, mechanic.data.retryTicks) then
					continue
				end
				local store = storeFor(w, builder, cargo)
				if store then
					ctx:add(builder, "Fetch", { from = NONE, to = store, resource = cargo, amount = goods.amount(w:get(builder, "Inventory"), cargo), full = true })
				end
			end
			w:flush()
		end,
	},
}

return mechanic
