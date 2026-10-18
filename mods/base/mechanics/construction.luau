--!strict
-- Стройка, разбор и починка. Площадка (Site) закладывается приказом build в своей зоне и тайлов не занимает, пока к ней
-- не приступили; с первой работой она становится недостроенным зданием (Footprint, прочность от SITE_FLOOR). Ремонтники
-- (Repair — строители, ремонтные турели) вкладывают работу во всё своё, до чего дотягиваются, глядя на него: чем их
-- больше, тем быстрее. Платят по ходу: за построенную долю — та же доля цены; кредитов нет — стройка стоит. Разбор
-- возвращает половину цены, отмена недостроенного — уплаченное, по ходу. Повреждённое чинят быстрее, чем строят, за
-- долю цены и не под огнём. Свободные строители сами берутся за работу поблизости. Правила места и кредитов —
-- lib/construction.
--
-- Материалы стройке подвозят грузовики и сами строители (mechanics/fetching): дальше привезённого она не идёт.
--
-- Привезённое на отменённую стройку и лежавшее на складе разобранного здания остаётся на земле (lib/drops); стройка
-- давит брошенный под ней груз.
--
-- Улучшение здания (Upgrade, mechanics/upgrades) — тоже работа строителей: оплачено сразу и ничего не ждёт;
-- повреждённое сначала чинят, станция его не делает.
--
-- Покрытие (lib/paving) — тоже работа строителей: тайл фундамента или дороги оплачен сразу и ничего не ждёт; готовое
-- уходит в слой карты, разбор снимает его оттуда. Фундамент под основанием ускоряет стройку. Инструмент «Снять»
-- разбирает рамкой покрытие, трубы и здания.

local construction = require("lib/construction")
local placement = require("lib/placement")
local zones = require("lib/zones")
local kinds = require("lib/kinds")
local wallet = require("lib/wallet")
local conversion = require("lib/conversion")
local queue = require("lib/queue")
local buildings = require("lib/buildings")
local economy = require("lib/economy")
local logistics = require("lib/logistics")
local drops = require("lib/drops")
local levels = require("lib/levels")
local paving = require("lib/paving")
local earthworks = require("lib/earthworks")

local readf64, writef64 = buffer.readf64, buffer.writef64

local mechanic = {}

mechanic.data = {
	-- С какого расстояния до работы свободный строитель сам берётся за неё, в тайлах.
	workRadius = 10,
	-- Раз во сколько тиков не дошедший до работы пробует подъехать снова и свободный смотрит вокруг.
	retryTicks = 20,
	-- Самая долгая отсрочка подъезда после промахов — 2^5 попыток.
	maxBackoff = 5,
	-- На сколько тайлов ближе своего радиуса встаёт ремонтник: юнит, которого он чинит, может сдвинуться.
	approachMargin = 0.5,
	-- На сколько тайлов вглубь основания приходится точка, над которой работают.
	workInset = 0.4,
	-- Насколько точно ремонтник должен смотреть на цель, чтобы работать, в радианах.
	repairAim = 0.2,
	-- Обзор недостроенного: половина основания и ещё столько тайлов.
	siteSight = 2,
}

mechanic.components = {
	-- Стройка или разбор: progress — тики работы из total; demolish — разбирают, undo — это отменённая стройка;
	-- blocked — на ещё пустой площадке стоят юниты, и стройка не начнётся.
	Site = { progress = 0, total = 1, demolish = false, undo = false, blocked = false },
	-- Ремонтник едет к работе site, чтобы она оказалась в его радиусе; ordered — работу дал игрок, а не взял сам
	-- свободный строитель; misses — сколько раз подряд не нашёл, как подъехать.
	Builds = { site = 0, ordered = true, misses = 0 },
	-- Строит, разбирает и чинит в радиусе radius со скоростью rate; target — над чем работает сейчас (-1 — ни над
	-- чем), working — работа идёт: смотрит на цель, и она не стоит (луч у клиента).
	Repair = { radius = 5, rate = 1, target = -1, working = false },
	-- Работа над покрытием тайла (lib/paving): kind — foundation или road; work — тиков работы одного строителя:
	-- у укладки — сделано, у разбора — осталось; done — покрытие готово (у разбора), remove — его разбирают.
	Pave = { kind = "road", work = 0, done = false, remove = false },
	-- Землеройная работа (lib/earthworks): kind — peak (срыть гору с вершиной peakX, peakY) или cliff (сгладить кромку
	-- в своём тайле); cost — уплаченное, work — тиков работы одного строителя сделано.
	Dig = { kind = "peak", cost = 0, work = 0, peakX = 0, peakY = 0 },
}

local TURN = math.pi * 2

-- Угол в пределах от −π до π (wrap).
local function wrap(angle: number): number
	return angle - TURN * math.floor(angle / TURN + 0.5)
end

local function turnToward(facing: number, wanted: number, maxTurn: number): number
	local off = wrap(wanted - facing)
	return if math.abs(off) <= maxTurn then wanted else wrap(facing + (if off < 0 then -1 else 1) * maxTurn)
end

local function onTurn(ctx, entity: number, ticks: number): boolean
	return (ctx.tick + entity) % ticks == 0
end

local function ownerOf(ctx, e: number): number
	local owner = ctx:get(e, "Owner")
	return if owner then owner.player else 0
end

local function isOwn(ctx, player: number, e: number): boolean
	return ctx:alive(e) and ownerOf(ctx, e) == player
end

-- Расстояние от точки до прямоугольника; внутри — ноль.
local function rectDistance(left: number, top: number, width: number, height: number, x: number, y: number): number
	local dx = math.max(left - x, 0, x - left - width)
	local dy = math.max(top - y, 0, y - top - height)
	return math.sqrt(dx * dx + dy * dy)
end

type Work = { x: number, y: number, width: number, height: number, radius: number, cost: number }

-- Улучшение, над которым здесь сейчас работают: его компонент, цена в кредитах и сколько тиков работы одного строителя
-- оно стоит. Повреждённое здание сначала чинят, а здание под разбором не улучшают: тогда улучшения в работе нет.
local function upgradeAt(ctx, e: number)
	local upgrade = ctx:get(e, "Upgrade")
	if not upgrade or ctx:has(e, "Site") or not ctx:has(e, "Building") or construction.isRepairable(ctx, e) then
		return nil
	end
	local kind = kinds.of(ctx, e)
	if not kind then
		return nil
	end
	local cost = levels.cost(kind, levels.of(ctx, e), upgrade.scale).credits
	return { upgrade = upgrade, cost = cost, ticks = construction.workTicks(cost, ctx.dt) }
end

-- Над чем здесь работают: стройка, разбор, починка или улучшение; nil — работы нет. Прямоугольник основания в тайлах; у
-- юнита — точка в его центре и радиус.
local function workAt(ctx, e: number): Work?
	if not ctx:alive(e) then
		return nil
	end
	-- Покрытие: тайл, который кладут или разбирают.
	local pave = ctx:get(e, "Pave")
	if pave then
		if pave.done and not pave.remove then
			return nil
		end
		local x, y = paving.tileOf(ctx, e)
		return { x = x, y = y, width = 1, height = 1, radius = 0, cost = paving.cost(ctx, pave.kind, x, y) }
	end
	-- Землеройная работа: гора или тайл кромки; сорвали — работы нет.
	local dig = ctx:get(e, "Dig")
	if dig then
		local area = earthworks.area(ctx, e)
		return if area then { x = area.x, y = area.y, width = area.width, height = area.height, radius = 0, cost = dig.cost } else nil
	end
	local kind = kinds.of(ctx, e)
	if not kind or not ctx:has(e, "Position") then
		return nil
	end
	local site = ctx:has(e, "Site")
	local raised = not site and upgradeAt(ctx, e)
	if not site and not raised and not construction.isRepairable(ctx, e) then
		return nil
	end
	local mover = ctx:get(e, "Mover")
	if not site and ctx:has(e, "Unit") then
		local at = ctx:get(e, "Position")
		return { x = at.x, y = at.y, width = 0, height = 0, radius = if mover then mover.radius else 0, cost = kind.data.cost }
	end
	if not ctx:has(e, "Building") then
		return nil
	end
	local size = ctx:get(e, "Building")
	local x, y = construction.corner(ctx, e)
	return { x = x, y = y, width = size.width, height = size.height, radius = 0, cost = if raised then raised.cost else kind.data.cost }
end

-- Расстояние от точки до края работы; внутри основания — ноль.
local function distanceTo(work: Work, x: number, y: number): number
	return math.max(0, rectDistance(work.x, work.y, work.width, work.height, x, y) - work.radius)
end

-- Попадали ли по этому в последние repairPause секунд: такое не чинят и к нему не едут.
local function underFire(ctx, e: number, rules): boolean
	local health = ctx:get(e, "Health")
	if not health or health.hit < 0 then
		return false
	end
	return ctx.tick - health.hit < rules.repairPause / ctx.dt
end

-- Тайлы, где стоят юниты, кроме ignore: на них не встают. radius — запас вокруг.
local function standingTiles(ctx, ignore: number, radius: number): { [string]: boolean }
	local tiles = {}
	for _, e in ctx:each({ "Unit", "Position", "Mover" }) do
		local mover = ctx:get(e, "Mover")
		if e == ignore or mover.class == "air" or ctx:has(e, "Path") then
			continue
		end
		local at = ctx:get(e, "Position")
		local reach = mover.radius + radius
		for y = math.floor(at.y - reach), math.floor(at.y + reach) do
			local dy = y + 0.5 - at.y
			for x = math.floor(at.x - reach), math.floor(at.x + reach) do
				local dx = x + 0.5 - at.x
				if dx * dx + dy * dy < reach * reach then
					tiles[x .. ":" .. y] = true
				end
			end
		end
	end
	return tiles
end

-- Подводит ремонтника к работе ровно настолько, чтобы она попала в его радиус: на ближайший к нему свободный тайл,
-- откуда он дотягивается (approach). claimed — тайлы, уже розданные этим же приказом. Возвращает, доведёт ли путь
-- до работы.
local function approach(ctx, builder: number, site: number, claimed: { [string]: boolean }): boolean
	local at = ctx:get(builder, "Position")
	local repair = ctx:get(builder, "Repair")
	local work = workAt(ctx, site)
	if not work or not repair or not at then
		return false
	end
	if distanceTo(work, at.x, at.y) <= repair.radius then
		return true
	end
	local reach = math.max(0, repair.radius - mechanic.data.approachMargin)
	local mover = ctx:get(builder, "Mover")
	local taken = standingTiles(ctx, builder, if mover then mover.radius else 0)
	local span = math.ceil(reach + work.radius)
	local bestX, bestY, best = 0, 0, math.huge
	for y = math.floor(work.y) - span, math.floor(work.y + work.height) + span do
		for x = math.floor(work.x) - span, math.floor(work.x + work.width) + span do
			local dx, dy = x + 0.5 - at.x, y + 0.5 - at.y
			local distance = math.sqrt(dx * dx + dy * dy)
			if distance >= best then
				continue
			end
			-- Само основание займёт здание.
			local edge = distanceTo(work, x + 0.5, y + 0.5)
			if edge > reach or (work.width > 0 and edge == 0) then
				continue
			end
			local key = x .. ":" .. y
			if claimed[key] or taken[key] or not ctx:walkable(x, y) then
				continue
			end
			-- На площадке не встают: оттуда попросят, как только там начнут строить.
			if construction.siteAt(ctx, x, y) then
				continue
			end
			bestX, bestY, best = x, y, distance
		end
	end
	if best == math.huge then
		return false
	end
	claimed[bestX .. ":" .. bestY] = true
	ctx:move(builder, bestX, bestY)
	local path = ctx:get(builder, "Path")
	local points = path and path.points
	return points ~= nil and #points >= 2 and distanceTo(work, points[#points - 1], points[#points]) <= repair.radius
end

-- Посылает своих ремонтников на стройку, разбор или чинить. Чужие, без Repair и разворачивающиеся выбрасываются; сам
-- себя ремонтник не чинит.
local function assignBuilders(ctx, player: number, site: number, units: { number }, ordered: boolean): boolean
	if not isOwn(ctx, player, site) or not workAt(ctx, site) then
		return false
	end
	local builders, seen = {}, {}
	for _, e in units do
		if type(e) == "number" and not seen[e] and e ~= site and ctx:alive(e) and ctx:has(e, "Unit") and ctx:has(e, "Repair") and isOwn(ctx, player, e) and not ctx:has(e, "Converting") then
			seen[e] = true
			table.insert(builders, e)
		end
	end
	local claimed = {}
	for _, builder in builders do
		ctx:add(builder, "Builds", { site = site, ordered = ordered, misses = 0 })
		approach(ctx, builder, site, claimed)
	end
	return #builders > 0
end

-- Освобождает основание площадки и говорит, свободно ли оно: свои стоящие с evict уходят, едущих не трогают, чужих
-- остаётся ждать.
local function clearSite(ctx, site: number, evict: boolean): boolean
	local x, y = construction.corner(ctx, site)
	local size = ctx:get(site, "Building")
	local inside = ctx:units_in(x, y, size.width, size.height)
	if #inside == 0 then
		return true
	end
	if evict then
		local player = ownerOf(ctx, site)
		local own = {}
		for _, e in inside do
			if ownerOf(ctx, e) == player and not ctx:has(e, "Path") then
				table.insert(own, e)
			end
		end
		ctx:evict(own, x, y, size.width, size.height)
	end
	return false
end

-- Строитель занят работой, которую дал ему игрок, или ждёт приказов в очереди: новую стройку из меню он не бросает, она
-- встаёт ему в очередь.
local isBusy = queue.busyBuilder

-- Стоит ли работа, хотя ремонтник до неё дотянулся: стройка вне зоны или с юнитами на ещё пустой площадке, починка —
-- без кредитов. Покрытие и улучшение оплачены сразу и ничего не ждут.
local function isStalled(ctx, e: number, rules, purse, all): boolean
	if ctx:has(e, "Pave") or ctx:has(e, "Dig") or upgradeAt(ctx, e) then
		return false
	end
	local site = ctx:get(e, "Site")
	if not site then
		return rules.repairCost > 0 and wallet.balance(purse, ownerOf(ctx, e)) <= 0
	end
	if site.demolish then
		return false
	end
	local kind = kinds.of(ctx, e)
	local x, y = construction.corner(ctx, e)
	if construction.outOfControl(ctx, ownerOf(ctx, e), kind, x, y, all) then
		return true
	end
	if construction.awaitsMaterials(ctx, e) then
		return true
	end
	return not ctx:has(e, "Footprint") and #ctx:units_in(x, y, kind.data.width, kind.data.height) > 0
end

-- Кто сейчас поворачивает ремонтника к работе: сам юнит или турель на носителе. facing — куда смотрит в мире.
local function turnerOf(ctx, e: number)
	local attached = ctx:get(e, "Attached")
	if attached then
		local hull = ctx:get(attached.parent, "Facing")
		local kind = kinds.of(ctx, e)
		local base = if hull then hull.angle else 0
		return { facing = wrap(base + attached.angle), turn = kind and kind.data.turn or 0, base = base, turret = true }
	end
	local facing = ctx:get(e, "Facing")
	local mover = ctx:get(e, "Mover")
	if not facing or not mover then
		return nil
	end
	return { facing = facing.angle, turn = mover.turn, base = 0, turret = false }
end

type Link = { from: number, to: number, rate: number, demolish: boolean, fromX: number, fromY: number, toX: number, toY: number, stalled: boolean }

-- Над чем сейчас работает каждый ремонтник: над той работой, к которой его послали, если дотягивается, а иначе — над
-- ближайшей из тех, до которых дотягивается и которые не стоят.
local function repairLinks(ctx, rules, purse, all): { Link }
	local links = {}
	local repairers = {}
	for _, e in ctx:each({ "Repair", "Position", "Owner" }) do
		-- На ходу, разворачиваясь и недостроенным не работают; турель — работает и на ходу носителя.
		local attached = ctx:get(e, "Attached")
		local carrier = if attached then attached.parent else e
		if ctx:has(e, "Path") or ctx:has(carrier, "Converting") or ctx:has(e, "Site") then
			continue
		end
		local at = ctx:get(e, "Position")
		local repair = ctx:get(e, "Repair")
		-- Ремонтная станция: готовая, не выключенная и с энергией — чинит на свою долю энергии.
		if ctx:has(e, "Building") then
			local share = if economy.switchedOff(ctx, e) then 0 else economy.shareOf(ctx, e)
			if share > 0 then
				table.insert(repairers, { entity = e, player = ownerOf(ctx, e), x = at.x, y = at.y, radius = repair.radius, rate = repair.rate * share, carrier = e, station = true })
			end
			continue
		end
		local builds = ctx:get(e, "Builds")
		table.insert(repairers, { entity = e, player = ownerOf(ctx, e), x = at.x, y = at.y, radius = repair.radius, rate = repair.rate, site = if builds then builds.site else nil, carrier = carrier })
	end
	if #repairers == 0 then
		return links
	end
	local targets = {}
	local overbuilt
	for _, e in ctx:each({ "Site", "Position", "Owner" }) do
		local work = workAt(ctx, e)
		if work then
			table.insert(targets, { entity = e, work = work, player = ownerOf(ctx, e), demolish = ctx:get(e, "Site").demolish })
		end
	end
	for _, e in ctx:each({ "Pave", "Position", "Owner" }) do
		local work = workAt(ctx, e)
		if work then
			table.insert(targets, { entity = e, work = work, player = ownerOf(ctx, e), demolish = ctx:get(e, "Pave").remove })
		end
	end
	for _, e in ctx:each({ "Dig", "Position", "Owner" }) do
		local work = workAt(ctx, e)
		if work then
			table.insert(targets, { entity = e, work = work, player = ownerOf(ctx, e), demolish = false })
		end
	end
	for _, e in ctx:each({ "Upgrade", "Position", "Owner" }) do
		local work = upgradeAt(ctx, e) and workAt(ctx, e)
		if work then
			table.insert(targets, { entity = e, work = work, player = ownerOf(ctx, e), demolish = false, upgrade = true })
		end
	end
	for _, e in ctx:each({ "Health", "Position", "Owner" }) do
		local health = ctx:get(e, "Health")
		-- По кому сейчас бьют, не чинят: посланный строитель постоит рядом и возьмётся, когда бой стихнет.
		if health.value < health.max and construction.isRepairable(ctx, e) and not underFire(ctx, e, rules) then
			local work = workAt(ctx, e)
			if work then
				-- Электростанцию, которой не хватило бы и целой, чинят только посланные к ней.
				overbuilt = overbuilt or economy.overbuilt(ctx)
				table.insert(targets, { entity = e, work = work, player = ownerOf(ctx, e), demolish = false, ordered = ctx:has(e, "Building") and overbuilt[e] == true })
			end
		end
	end
	local stalled = {}
	local function stands(e: number): boolean
		if stalled[e] == nil then
			stalled[e] = isStalled(ctx, e, rules, purse, all)
		end
		return stalled[e]
	end
	local inset = mechanic.data.workInset
	for _, repairer in repairers do
		local best, bestDistance = nil, math.huge
		for _, target in targets do
			-- Себя и свой носитель ремонтник не чинит.
			if target.player ~= repairer.player or target.entity == repairer.carrier then
				continue
			end
			-- Станция только чинит: стройки, покрытие, разбор и улучшение — работа строителя.
			if repairer.station and (target.upgrade or ctx:has(target.entity, "Site") or ctx:has(target.entity, "Pave") or ctx:has(target.entity, "Dig")) then
				continue
			end
			if target.ordered and repairer.site ~= target.entity then
				continue
			end
			local distance = distanceTo(target.work, repairer.x, repairer.y)
			if distance > repairer.radius then
				continue
			end
			-- Посланный к работе занят ею, остальное подождёт.
			if repairer.site == target.entity then
				best = target
				break
			end
			if distance < bestDistance and not stands(target.entity) then
				best, bestDistance = target, distance
			end
		end
		if best then
			local work = best.work
			local insetX, insetY = math.min(inset, work.width / 2), math.min(inset, work.height / 2)
			table.insert(links, {
				from = repairer.entity,
				to = best.entity,
				rate = repairer.rate,
				demolish = best.demolish,
				fromX = repairer.x,
				fromY = repairer.y,
				toX = math.min(work.x + work.width - insetX, math.max(work.x + insetX, repairer.x)),
				toY = math.min(work.y + work.height - insetY, math.max(work.y + insetY, repairer.y)),
				stalled = stands(best.entity),
			})
		end
	end
	return links
end

-- Новые площадки по приказу игрока: с основания уходят свои, к ней едут строители, которых дали. Покрытие тайлов
-- не занимает, и уходить с него незачем.
local function laid(ctx, player: number, site: number, builders: { number })
	if not ctx:alive(site) then
		return
	end
	if ctx:has(site, "Site") then
		clearSite(ctx, site, true)
	end
	assignBuilders(ctx, player, site, builders, true)
end

-- Свободные строители сами берутся за работу поблизости: каждый — за ближайшую свою стройку, разбор или повреждённое
-- стоящее не дальше workRadius; стройку вне зоны не берут — она всё равно стоит (volunteer). Смотрят вокруг раз в
-- retryTicks, каждый в свой тик.
local function volunteer(ctx, rules, all)
	local data = mechanic.data
	local idle = {}
	for _, e in ctx:each({ "Repair", "Unit", "Owner" }) do
		if not onTurn(ctx, e, data.retryTicks) or ctx:has(e, "Converting") or ctx:has(e, "Fetch") then
			continue
		end
		-- Стройка, которая ждёт материалов, строителя не держит: он берётся за другую работу, а вернётся, когда подвезут;
		-- разве что материал есть где взять — тогда он поедет за ним (mechanics/fetching).
		local builds = ctx:get(e, "Builds")
		if builds then
			if not construction.awaitsMaterials(ctx, builds.site) or logistics.willFetch(ctx, e, builds.site) then
				continue
			end
		elseif ctx:has(e, "Path") then
			continue
		end
		table.insert(idle, e)
	end
	if #idle == 0 then
		return
	end
	local sites = {}
	local overbuilt
	for _, e in ctx:each({ "Site", "Position", "Owner" }) do
		-- Ждущая материалов стройка добровольцев не зовёт: работы для них там нет.
		local work = not construction.awaitsMaterials(ctx, e) and workAt(ctx, e)
		if work then
			local site = ctx:get(e, "Site")
			table.insert(sites, { entity = e, work = work, player = ownerOf(ctx, e), kind = if site.demolish then nil else kinds.of(ctx, e) })
		end
	end
	-- Покрытие зоны не ждёт: строители переходят с тайла на соседний сами. Землеройные работы — тоже.
	for _, e in ctx:each({ "Pave", "Position", "Owner" }) do
		local work = workAt(ctx, e)
		if work then
			table.insert(sites, { entity = e, work = work, player = ownerOf(ctx, e) })
		end
	end
	for _, e in ctx:each({ "Dig", "Position", "Owner" }) do
		local work = workAt(ctx, e)
		if work then
			table.insert(sites, { entity = e, work = work, player = ownerOf(ctx, e) })
		end
	end
	for _, e in ctx:each({ "Upgrade", "Position", "Owner" }) do
		local work = upgradeAt(ctx, e) and workAt(ctx, e)
		if work then
			table.insert(sites, { entity = e, work = work, player = ownerOf(ctx, e) })
		end
	end
	for _, e in ctx:each({ "Health", "Position", "Owner" }) do
		local health = ctx:get(e, "Health")
		-- За едущим юнитом сами не гоняются: встанет — починят. К тому, по кому бьют, тоже не едут: переждут бой.
		if health.value < health.max and construction.isRepairable(ctx, e) and not ctx:has(e, "Path") and not underFire(ctx, e, rules) then
			-- Электростанцию, которой не хватило бы и целой, сами не чинят: починка зря жгла бы кредиты.
			overbuilt = overbuilt or economy.overbuilt(ctx)
			local work = not overbuilt[e] and workAt(ctx, e)
			if work then
				table.insert(sites, { entity = e, work = work, player = ownerOf(ctx, e) })
			end
		end
	end
	local open = {}
	for _, builder in idle do
		local at = ctx:get(builder, "Position")
		local player = ownerOf(ctx, builder)
		local best, bestDistance = nil, data.workRadius
		for _, site in sites do
			if site.player ~= player or site.entity == builder then
				continue
			end
			local distance = distanceTo(site.work, at.x, at.y)
			if distance > bestDistance then
				continue
			end
			local workable = open[site.entity]
			if workable == nil then
				workable = site.kind == nil or not construction.outOfControl(ctx, player, site.kind, site.work.x, site.work.y, all)
				open[site.entity] = workable
			end
			if workable then
				best, bestDistance = site.entity, distance
			end
		end
		if best then
			assignBuilders(ctx, player, best, { builder }, false)
		end
	end
end

-- Что из шаблона вида (entity) получает здание: таблица компонентов.
local function template(ctx, kind)
	local make = kind.entity
	if type(make) == "function" then
		return make(kind, ctx.protos) or {}
	end
	return make or {}
end

-- Первая работа: площадка становится недостроенным зданием — занимает тайлы, получает прочность и обзор.
local function begin(ctx, e: number, kind, health: { value: number, max: number })
	local shape = template(ctx, kind)
	ctx:add(e, "Footprint", shape.Footprint or { width = kind.data.width, height = kind.data.height })
	local hp = shape.Health or {}
	ctx:add(e, "Health", { hp = hp.hp, repairable = if hp.repairable == nil then true else hp.repairable, value = health.value, max = health.max })
	ctx:add(e, "Sight", { radius = math.max(kind.data.width, kind.data.height) / 2 + mechanic.data.siteSight })
end

-- Здание достроено: всё, что положено его виду, — производство, обзор, ремонт; турели ставит mechanics/mounts.
-- Материалы ушли в здание: склад у готового свой.
local function finish(ctx, e: number, kind, player: number)
	local shape = template(ctx, kind)
	if ctx:has(e, "Inventory") then
		ctx:remove(e, "Inventory")
	end
	-- Лист площадки становится связью готового здания.
	if ctx:has(e, "Link") then
		ctx:remove(e, "Link")
	end
	for name, values in shape do
		if name == "Position" or name == "Owner" or name == "Health" or name == "Footprint" or name == "Building" then
			continue
		end
		if name == "Sight" then
			ctx:set(e, "Sight", values)
		else
			ctx:add(e, name, values)
		end
	end
	ctx:remove(e, "Site")
	ctx:emit("built", { entity = e, player = player })
	local at = ctx:get(e, "Position")
	ctx:signal("built", { entity = e, player = player, building = kind.name, x = at.x, y = at.y })
end

-- Закладывает площадку вида kind левым верхним тайлом в (x, y) без проверок: материалы привезут грузовики, трубы и
-- строители. Номер известен сразу, а площадка появится после системы.
local function laySite(ctx, player: number, kind, x: number, y: number): number
	local data = kind.data
	return ctx:spawn(nil, {
		Proto = { id = kind.id },
		Position = { x = placement.middle(x, data.width), y = placement.middle(y, data.height) },
		Owner = { player = player },
		Building = { width = data.width, height = data.height },
		Site = { progress = 0, total = construction.siteTicks(kind, ctx.dt) },
		Inventory = construction.siteStock(kind),
		Link = if data.materials then buildings.siteLink(kind) else nil,
	})
end

-- Свободные из данных строителей: свои, живые, не занятые делом игрока.
local function freeBuilders(ctx, list): { number }
	local free = {}
	for _, e in (if type(list) == "table" then list else {}) do
		if type(e) == "number" and ctx:alive(e) and not isBusy(ctx, e) then
			table.insert(free, e)
		end
	end
	return free
end

-- Убирает трубу, вместо которой кладут другую, сразу: заложенную — даром, начатую — с возвратом уплаченного, готовую —
-- с возвратом как за разбор.
local function replacePipe(ctx, player: number, e: number)
	local kind = kinds.of(ctx, e)
	local site = ctx:get(e, "Site")
	if site then
		if ctx:has(e, "Footprint") then
			wallet.refund(ctx, player, math.floor(site.progress / site.total * kind.data.cost))
		end
	else
		wallet.refund(ctx, player, construction.refundOf(kind))
	end
	-- Привезённые материалы остаются на земле.
	drops.cargo(ctx, e)
	ctx:destroy(e)
end

-- Протяжка: закладывает тайлы, которые годятся, и посылает строителей к первой площадке.
local function stroke(ctx, player: number, kind, tiles, builders, allowed: { boolean }, swap: boolean, kept: { boolean }?, queued: boolean?): boolean
	local first = nil
	for i, ok in allowed do
		local x, y = tiles[i * 2 - 1], tiles[i * 2]
		if kept and kept[i] then
			continue
		end
		if not ok then
			continue
		end
		if swap then
			local other = construction.pipeSwap(ctx, player, kind, x, y)
			if other then
				replacePipe(ctx, player, other)
			end
		end
		local site = laySite(ctx, player, kind, x, y)
		first = first or site
	end
	if not first then
		return false
	end
	-- Как и стройка из меню, протяжка не отнимает строителя у работы игрока: занятым она встаёт в очередь (lay).
	local free = if queued then {} else freeBuilders(ctx, builders)
	local busy = {}
	for _, e in (if type(builders) == "table" then builders else {}) do
		if type(e) == "number" and ctx:alive(e) and not table.find(free, e) then
			table.insert(busy, e)
		end
	end
	if #busy > 0 then
		queue.push(ctx, player, "assist", { site = first }, busy)
	end
	ctx:emit("laid", { site = first, player = player, builders = free })
	ctx:signal("laid", { player = player, x = tiles[1], y = tiles[2] })
	return true
end

-- Тайлы протяжки: целые числа подряд, не больше STROKE_LIMIT тайлов.
local function strokeTiles(list): { number }?
	if type(list) ~= "table" then
		return nil
	end
	local tiles = {}
	for i, value in list do
		if type(value) ~= "number" or i > construction.STROKE_LIMIT * 2 then
			break
		end
		table.insert(tiles, value)
	end
	return if #tiles >= 2 then tiles else nil
end

-- Строители протяжки: свои юниты из списка; без Shift занятые делом игрока (busy) получат работу в очередь, а свободные
-- (free) поедут сразу; с Shift (queued) в очередь встаёт всем.
local function split(ctx, player: number, list, queued: boolean): ({ number }, { number })
	local free, busy = {}, {}
	for _, e in (if type(list) == "table" then list else {}) do
		if type(e) == "number" and ctx:alive(e) and ctx:has(e, "Unit") and isOwn(ctx, player, e) and not table.find(free, e) and not table.find(busy, e) then
			table.insert(if queued or isBusy(ctx, e) then busy else free, e)
		end
	end
	return free, busy
end

-- Работа заложена: свободные едут к первой, занятым она встаёт в очередь.
local function dispatch(ctx, player: number, first: number, free: { number }, busy: { number })
	if #busy > 0 then
		queue.push(ctx, player, "assist", { site = first }, busy)
	end
	ctx:emit("laid", { site = first, player = player, builders = free })
end

-- Отменяет стройку. Не начатая исчезает сразу; начатая разбирается, и уплаченное за неё возвращается по ходу разбора;
-- отмена разбора оставляет здание целым. Разбор отменённой стройки не отменить. Возвращает, стала ли стройка работой —
-- разбором начатого.
local function cancelSite(ctx, site: number): boolean
	local state = ctx:get(site, "Site")
	if not state or state.undo then
		return false
	end
	if state.demolish then
		ctx:remove(site, "Site")
		-- Разбор отменён: здание снова в сети.
		local link = buildings.link(kinds.of(ctx, site))
		if link then
			ctx:add(site, "Link", link)
		end
		return false
	elseif ctx:has(site, "Footprint") then
		ctx:set(site, "Site", { demolish = true, undo = true })
		-- Разбираемое материалов уже не ждёт.
		if ctx:has(site, "Link") then
			ctx:remove(site, "Link")
		end
		return true
	end
	-- Привезённые материалы остаются на земле.
	drops.cargo(ctx, site)
	ctx:destroy(site)
	return false
end

-- Начинает разбор своего готового здания (demolish): разбирают строители, быстрее, чем строят; половина цены
-- вернётся, когда разберут. С этого момента здание не работает и зону не расширяет.
local function demolishBuilding(ctx, player: number, building: number): boolean
	if not ctx:alive(building) or not construction.canDemolish(ctx, player, building) then
		return false
	end
	-- Недоделанное улучшение разбор отменяет: его цена возвращается целиком.
	levels.cancel(ctx, player, building)
	local total = construction.siteTicks(kinds.of(ctx, building), ctx.dt)
	ctx:add(building, "Site", { progress = total, total = total, demolish = true })
	ctx:remove(building, "Link")
	return true
end

mechanic.commands = {
	-- { kind, tiles, builders, queue } — заложить покрытие (foundation, road) в тайлы x, y подряд и послать к нему
	-- строителей. Платят за каждый тайл сразу; на что не хватило кредитов и куда нельзя — не кладут. Дальше по соседним
	-- тайлам строители пойдут сами.
	pave = function(ctx, player, args)
		local tiles = strokeTiles(args.tiles)
		local kind = args.kind
		if not tiles or type(kind) ~= "string" or not paving.CODE[kind] then
			return
		end
		local free, busy = split(ctx, player, args.builders, args.queue == true)
		local purse = wallet.purse(ctx)
		local all = zones.all(ctx)
		local first, taken = nil, {}
		for i = 1, #tiles - 1, 2 do
			local x, y = tiles[i], tiles[i + 1]
			local key = x .. ":" .. y
			if taken[key] or not paving.canPave(ctx, player, kind, x, y, all) or not wallet.spend(purse, player, paving.cost(ctx, kind, x, y)) then
				continue
			end
			taken[key] = true
			local e = paving.open(ctx, player, x, y, { kind = kind })
			first = first or e
		end
		wallet.flush(purse)
		if first then
			dispatch(ctx, player, first, free, busy)
		end
	end,

	-- { kind, tiles, builders, queue } — землеройные работы в рамке тайлов x, y подряд: kind — peak (срыть горы, по
	-- работе на гору) или cliff (сгладить кромки обрыва, по работе на тайл). Платят за каждую сразу; на что не хватило
	-- кредитов — не заказывают. К первой посылают строителей.
	dig = function(ctx, player, args)
		local tiles = strokeTiles(args.tiles)
		local kind = args.kind
		if not tiles or type(kind) ~= "string" or not table.find(earthworks.KINDS, kind) then
			return
		end
		local free, busy = split(ctx, player, args.builders, args.queue == true)
		local purse = wallet.purse(ctx)
		local first = nil
		for _, job in earthworks.digsIn(ctx, player, kind, tiles) do
			if wallet.spend(purse, player, job.cost) then
				local e = ctx:spawn(nil, { Position = { x = job.x, y = job.y }, Owner = { player = player }, Dig = { kind = kind, cost = job.cost, peakX = job.peakX, peakY = job.peakY } })
				first = first or e
			end
		end
		wallet.flush(purse)
		if first then
			dispatch(ctx, player, first, free, busy)
		end
	end,

	-- { tiles, builders, queue } — снять своё на тайлах: покрытие, трубы с колодцами и здания, основание которых
	-- целиком попало в тайлы (главное здание не разбирают — его сворачивают). Недостроенное покрытие и не начатые
	-- стройки отменяются сразу, с возвратом кредитов целиком; готовое покрытие строители разбирают без возврата,
	-- готовые трубы и здания — с возвратом половины цены. Без своих строителей не снимают ничего.
	remove = function(ctx, player, args)
		local tiles = strokeTiles(args.tiles)
		if not tiles then
			return
		end
		local free, busy = split(ctx, player, args.builders, args.queue == true)
		local any = false
		for _, e in table.move(busy, 1, #busy, #free + 1, table.clone(free)) do
			any = any or ctx:has(e, "Repair")
		end
		if not any then
			return
		end
		local covered = {}
		for i = 1, #tiles - 1, 2 do
			covered[tiles[i] .. ":" .. tiles[i + 1]] = true
		end
		local core = conversion.building(ctx)
		local purse = wallet.purse(ctx)
		local first = nil
		local taken, seen = {}, {}
		for i = 1, #tiles - 1, 2 do
			local x, y = tiles[i], tiles[i + 1]
			-- Трубу снимают, даже если рамка задела её одним тайлом: она сама в тайл.
			local pipe = construction.pipeAt(ctx, player, x, y)
			if pipe and not seen[pipe] then
				seen[pipe] = true
				table.insert(taken, pipe)
			end
			local building = paving.buildingWithin(ctx, player, x, y, covered, core)
			if building and not seen[building] then
				seen[building] = true
				table.insert(taken, building)
			end
			-- Землеройную работу отменяют: кредиты возвращаются целиком, как у не начатой площадки.
			local dug = earthworks.digAt(ctx, x, y)
			if dug and not seen[dug] and isOwn(ctx, player, dug) then
				seen[dug] = true
				wallet.add(purse, player, ctx:get(dug, "Dig").cost)
				ctx:destroy(dug)
			end
			local e = paving.at(ctx, x, y)
			if e then
				if not isOwn(ctx, player, e) then
					continue
				end
				local pave = ctx:get(e, "Pave")
				if not pave.done then
					wallet.add(purse, player, paving.cost(ctx, pave.kind, x, y))
					paving.forget(ctx, e)
					continue
				end
				ctx:set(e, "Pave", { remove = true })
				first = first or e
				continue
			end
			-- Готовое покрытие разбирают строители: на тайле заводится работа разбора, а покрытие действует, пока она идёт.
			local kind, owner = paving.laid(ctx, x, y)
			if not kind or owner ~= player then
				continue
			end
			local work = construction.workTicks(paving.cost(ctx, kind, x, y), ctx.dt)
			local e = paving.open(ctx, player, x, y, { kind = kind, work = work, done = true, remove = true })
			first = first or e
		end
		wallet.flush(purse)
		for _, e in taken do
			-- Стройку отменяют: площадка исчезает сразу, недостроенное строители разбирают, как и готовое.
			if ctx:has(e, "Site") then
				if cancelSite(ctx, e) then
					first = first or e
				end
			elseif demolishBuilding(ctx, player, e) then
				first = first or e
			end
		end
		if first then
			dispatch(ctx, player, first, free, busy)
		end
	end,

	-- { tiles, builders } — протянутая наземная труба (x, y подряд, по порядку протяжки). Свой колодец на пути заменяется
	-- трубой; куда нельзя — не кладут. Платят по ходу стройки.
	pipes = function(ctx, player, args)
		local tiles = strokeTiles(args.tiles)
		local kind = ctx.protos.buildings.pipe
		if tiles and kind then
			stroke(ctx, player, kind, tiles, args.builders, construction.pipeStroke(ctx, player, tiles, kind), true, nil, args.queue == true)
		end
	end,

	-- { tiles, builders } — колодец (x, y) или пара — концы подземного отрезка на одной прямой. Конец, где свой колодец
	-- уже стоит, остаётся; пару кладут целиком или никак.
	wells = function(ctx, player, args)
		local tiles = strokeTiles(args.tiles)
		local kind = ctx.protos.buildings.well
		if not tiles or not kind or not (#tiles == 2 or construction.isWellPair(tiles)) then
			return
		end
		local kept = construction.wellsKept(ctx, player, tiles)
		local fits = construction.pipeStroke(ctx, player, tiles, kind)
		local fresh = 0
		for i, ok in fits do
			if not kept[i] then
				fresh += 1
				if not ok then
					return
				end
			end
		end
		if fresh > 0 then
			stroke(ctx, player, kind, tiles, args.builders, fits, true, kept, args.queue == true)
		end
	end,

	-- { tiles, builders, gate } — протянутая стена или ворота.
	walls = function(ctx, player, args)
		local tiles = strokeTiles(args.tiles)
		local kind = ctx.protos.buildings[if args.gate == true then "gate" else "wall"]
		if tiles and kind then
			stroke(ctx, player, kind, tiles, args.builders, construction.wallStroke(ctx, player, tiles, kind), false, nil, args.queue == true)
		end
	end,

	-- { building, x, y, builders, queue } — заложить здание левым верхним тайлом основания в (x, y) и послать строителей.
	-- Заложить можно и без кредитов: платят по ходу. Занятых делом игрока строителей стройка из меню не отнимает: им
	-- она встаёт в очередь; с Shift (queue) — в очередь всем.
	build = function(ctx, player, args)
		local kind = type(args.building) == "string" and ctx.protos.buildings[args.building]
		if not kind or type(args.x) ~= "number" or type(args.y) ~= "number" then
			return
		end
		if not construction.canBuild(ctx, player, kind, args.x, args.y) then
			ctx:signal("refused", { player = player, reason = "place" })
			return
		end
		local site = laySite(ctx, player, kind, args.x, args.y)
		local free, busy = {}, {}
		for _, e in (if type(args.builders) == "table" then args.builders else {}) do
			if type(e) == "number" and ctx:alive(e) then
				table.insert(if args.queue or isBusy(ctx, e) then busy else free, e)
			end
		end
		if #busy > 0 then
			queue.push(ctx, player, "assist", { site = site }, busy)
		end
		ctx:emit("laid", { site = site, player = player, builders = free })
		ctx:signal("laid", { player = player, x = args.x, y = args.y })
	end,

	-- { units, site, queue } — послать своих строителей на свою стройку, разбор или чинить.
	assist = function(ctx, player, args)
		if type(args.site) ~= "number" or type(args.units) ~= "table" then
			return
		end
		if args.queue then
			queue.push(ctx, player, "assist", { site = args.site }, args.units)
		elseif assignBuilders(ctx, player, args.site, args.units, true) then
			queue.forget(ctx, args.units)
			conversion.forget(ctx, args.units)
		end
	end,

	-- { site } — отменить стройку. Не начатая исчезает сразу; начатая разбирается, и уплаченное за неё возвращается по
	-- ходу разбора; отмена разбора оставляет здание целым. Разбор отменённой стройки не отменить.
	cancelBuild = function(ctx, player, args)
		local site = args.site
		if type(site) == "number" and isOwn(ctx, player, site) then
			cancelSite(ctx, site)
		end
	end,

	-- { building, builders } — разобрать своё готовое здание (demolish): разбирают строители, быстрее, чем строят;
	-- половина цены вернётся, когда разберут. С этого момента здание не работает и зону не расширяет.
	demolish = function(ctx, player, args)
		local building = args.building
		if type(building) == "number" and demolishBuilding(ctx, player, building) then
			ctx:emit("laid", { site = building, player = player, builders = if type(args.builders) == "table" then args.builders else {} })
		end
	end,
}

mechanic.on = {
	laid = function(ctx, event)
		laid(ctx, event.player, event.site, event.builders)
	end,
	-- Приказ точкой по своей стройке или повреждённому (mechanics/orders).
	assist = function(ctx, event)
		if assignBuilders(ctx, event.player, event.site, event.units, true) then
			conversion.forget(ctx, event.units)
		end
	end,
	-- Наземный взрыв боя разбивает плиты фундамента.
	blast = function(ctx, event)
		paving.breakSlabs(ctx, event.x, event.y, event.size)
	end,
}

mechanic.systems = {
	-- После хода и носителей: работающий поворачивается к работе (construct). До боя: урон этого тика откатит стройку
	-- уже в следующем.
	construct = {
		query = { "Repair" },
		write = { "Repair" },
		after = { "follow" },
		before = { "fight" },
		run = function(q, ctx)
			local data = mechanic.data
			local rules = construction.rules(ctx)
			local purse = wallet.purse(ctx)
			local all = zones.all(ctx)
			local dt = ctx.dt

			-- Строители: работы нет — забывают её; не доехал или оттеснили — пробует снова, всё реже.
			for _, e in ctx:each({ "Builds", "Position", "Unit", "Repair" }) do
				local builds = ctx:get(e, "Builds")
				local work = workAt(ctx, builds.site)
				if not work then
					ctx:remove(e, "Builds")
					continue
				end
				if ctx:has(e, "Path") then
					continue
				end
				local at = ctx:get(e, "Position")
				if distanceTo(work, at.x, at.y) > ctx:get(e, "Repair").radius and onTurn(ctx, e, bit32.lshift(data.retryTicks, math.min(builds.misses, data.maxBackoff))) then
					ctx:set(e, "Builds", { misses = if approach(ctx, e, builds.site, {}) then 0 else builds.misses + 1 })
				end
			end
			volunteer(ctx, rules, all)

			-- На пустых площадках стоят юниты — так и видно игроку, почему стройка не начинается.
			for _, e in ctx:each({ "Site", "Building", "Position" }) do
				local site = ctx:get(e, "Site")
				if not site.demolish and not ctx:has(e, "Footprint") then
					local x, y = construction.corner(ctx, e)
					local size = ctx:get(e, "Building")
					local blocked = #ctx:units_in(x, y, size.width, size.height) > 0
					if blocked ~= site.blocked then
						ctx:set(e, "Site", { blocked = blocked })
					end
				end
			end

			-- Работа за тик: ремонтник поворачивается к цели и, если смотрит на неё, вкладывает работу.
			local rows = {}
			for i = 0, q.n - 1 do
				rows[readf64(q.entity, i * 8)] = i * 8
				writef64(q.Repair.target, i * 8, -1)
				writef64(q.Repair.working, i * 8, 0)
			end
			local done = {}
			for _, link in repairLinks(ctx, rules, purse, all) do
				local row = rows[link.from]
				if row then
					writef64(q.Repair.target, row, link.to)
				end
				local turner = turnerOf(ctx, link.from)
				local aimed = true
				if turner then
					local facing = turnToward(turner.facing, math.atan2(link.toY - link.fromY, link.toX - link.fromX), turner.turn * dt)
					if turner.turret then
						ctx:set(link.from, "Attached", { angle = wrap(facing - turner.base) })
					else
						ctx:set(link.from, "Facing", { angle = facing })
					end
					aimed = math.abs(wrap(math.atan2(link.toY - link.fromY, link.toX - link.fromX) - facing)) <= data.repairAim
				end
				if aimed then
					done[link.to] = (done[link.to] or 0) + link.rate
					if row and not link.stalled then
						writef64(q.Repair.working, row, 1)
					end
				end
			end

			-- По номерам: порядок трат один и тот же при любом порядке ремонтников.
			local worked = {}
			for e in done do
				table.insert(worked, e)
			end
			table.sort(worked)
			for _, e in worked do
				local count = done[e]
				-- Землеройная работа: копится, пока не наберётся вся; тогда земля правится.
				local dig = ctx:get(e, "Dig")
				if dig then
					local work = dig.work + count
					if work < construction.workTicks(dig.cost, dt) then
						ctx:set(e, "Dig", { work = work })
					else
						earthworks.finish(ctx, e)
					end
					continue
				end
				local pave = ctx:get(e, "Pave")
				if pave then
					local x, y = paving.tileOf(ctx, e)
					if pave.remove then
						-- Разбирают: покрытие действует, пока работа не кончится, потом уходит с тайла вместе с ней.
						local work = pave.work - count * construction.DEMOLISH_SPEED
						if work > 0 then
							ctx:set(e, "Pave", { work = work })
						else
							paving.lift(ctx, x, y)
							paving.forget(ctx, e)
						end
						continue
					end
					local work = pave.work + count
					if work < construction.workTicks(paving.cost(ctx, pave.kind, x, y), dt) then
						ctx:set(e, "Pave", { work = work })
					else
						-- Уложили: тайл становится готовым покрытием хозяина работы.
						paving.lay(ctx, x, y, pave.kind, ownerOf(ctx, e))
						paving.forget(ctx, e)
					end
					continue
				end
				local kind = kinds.of(ctx, e)
				local site = ctx:get(e, "Site")
				local player = ownerOf(ctx, e)
				local raised = not site and upgradeAt(ctx, e)
				if raised then
					-- Улучшение: работа копится, пока не наберётся вся; тогда здание на уровень выше.
					local progress = raised.upgrade.progress + count
					if progress < raised.ticks then
						ctx:set(e, "Upgrade", { progress = progress })
						continue
					end
					local level = levels.of(ctx, e) + 1
					ctx:remove(e, "Upgrade")
					ctx:set(e, "Building", { level = level })
					levels.apply(ctx, e, level)
					continue
				end
				if not site then
					-- Починка идёт быстрее стройки и оплачивается по мере работы; кончились кредиты — стоит.
					local health = ctx:get(e, "Health")
					if not health or not kind or underFire(ctx, e, rules) then
						continue
					end
					local cost = kind.data.cost
					local gain = math.min(health.max - health.value, count * rules.repairSpeed / construction.workTicks(cost, dt))
					local price = gain * cost * rules.repairCost
					if price <= 0 or wallet.spend(purse, player, price) then
						ctx:set(e, "Health", { value = health.value + gain })
					end
					continue
				end
				local total = site.total
				if site.demolish then
					local progress = site.progress - count * construction.DEMOLISH_SPEED
					-- Отменённая стройка возвращает уплаченное за снятую долю по ходу, как платили за построенную.
					if site.undo then
						wallet.earn(purse, player, (site.progress - math.max(0, progress)) / total * kind.data.cost)
					end
					if progress > 0 then
						ctx:set(e, "Site", { progress = progress })
						continue
					end
					if not site.undo then
						-- Оплаченное вперёд — очередь юнитов — возвращается целиком, как при отмене.
						wallet.add(purse, player, construction.refundOf(kind, levels.of(ctx, e)) + construction.prepaidOf(ctx, e))
					end
					-- Что лежало на складе здания или стройки, остаётся на земле.
					drops.cargo(ctx, e)
					ctx:destroy(e)
					continue
				end
				local x, y = construction.corner(ctx, e)
				if construction.outOfControl(ctx, player, kind, x, y, all) then
					continue
				end
				local health = ctx:get(e, "Health")
				if not ctx:has(e, "Footprint") then
					-- Выгонять пробуют не каждый тик: поиск пути недёшев.
					if not clearSite(ctx, e, onTurn(ctx, e, data.retryTicks)) then
						continue
					end
					local durability = construction.durabilityOf(ctx, kind, x, y)
					health = { value = durability * construction.SITE_FLOOR, max = durability }
					begin(ctx, e, kind, health)
					-- Стройка давит брошенный под ней груз.
					drops.clear(ctx, x, y, kind.data.width, kind.data.height)
				end
				-- Прочность недостроенного — доля построенного: урон откатывает стройку, и разбитое строят и оплачивают
				-- заново. Платят по ходу: за каждую построенную долю — та же доля цены; кончились кредиты — стоит.
				-- Дальше привезённых материалов стройка не идёт. Фундамент под основанием меняет скорость стройки.
				local progress = math.min(site.progress, total * health.value / health.max)
				local reached = math.min(progress + count * paving.buildSpeed(ctx, kind, x, y), total, total * construction.materialShare(ctx, e))
				if reached > progress and wallet.spend(purse, player, (reached - progress) / total * kind.data.cost) then
					progress = reached
				end
				local value = math.max(health.value, health.max * math.max(construction.SITE_FLOOR, progress / total))
				-- Доли работы складываются с погрешностью: 399,99999999999966 из 400 — уже готово.
				if progress < total - 1e-9 then
					ctx:set(e, "Site", { progress = progress })
					ctx:set(e, "Health", { value = value })
					continue
				end
				ctx:set(e, "Health", { value = health.max })
				finish(ctx, e, kind, player)
			end
			wallet.flush(purse)
		end,
	},
}

-- На клиенте: здание достроено — звук готового; своё отвергнутое место — жужжание.
mechanic.signals = {
	built = function(c, signal)
		c:sound("built", { x = signal.x, y = signal.y, volume = 0.5 })
	end,
	laid = function(c, signal)
		if signal.player == c.player then
			c:sound("place", { volume = 0.35 })
		end
	end,
}

return mechanic
