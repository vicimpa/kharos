--!strict
-- Стройка, разбор и починка — перенос construction.ts. Площадка (Site) закладывается приказом build в своей зоне и
-- тайлов не занимает, пока к ней не приступили; с первой работой она становится недостроенным зданием (Footprint,
-- прочность от SITE_FLOOR). Ремонтники (Repair — строители, ремонтные турели) вкладывают работу во всё своё, до чего
-- дотягиваются, глядя на него: чем их больше, тем быстрее. Платят по ходу: за построенную долю — та же доля цены;
-- кредитов нет — стройка стоит. Разбор возвращает половину цены, отмена недостроенного — уплаченное, по ходу.
-- Повреждённое чинят быстрее, чем строят, за долю цены и не под огнём. Свободные строители сами берутся за работу
-- поблизости. Правила места и кредитов — lib/construction.
--
-- Материалы стройке подвозят грузовики и сами строители (mechanics/fetching): дальше привезённого она не идёт.
--
-- Привезённое на отменённую стройку и лежавшее на складе разобранного здания остаётся на земле (lib/drops); стройка
-- давит брошенный под ней груз.
--
-- Пока нет: покрытия и землеройных работ, улучшений зданий.

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

local readf64, writef64 = buffer.readf64, buffer.writef64

local mechanic = {}

mechanic.data = {
	-- С какого расстояния до работы свободный строитель сам берётся за неё, в тайлах (WORK_RADIUS).
	workRadius = 10,
	-- Раз во сколько тиков не дошедший до работы пробует подъехать снова и свободный смотрит вокруг (RETRY_TICKS).
	retryTicks = 20,
	-- Самая долгая отсрочка подъезда после промахов — 2^5 попыток (MAX_BACKOFF).
	maxBackoff = 5,
	-- На сколько тайлов ближе своего радиуса встаёт ремонтник: юнит, которого он чинит, может сдвинуться.
	approachMargin = 0.5,
	-- На сколько тайлов вглубь основания приходится точка, над которой работают (WORK_INSET).
	workInset = 0.4,
	-- Насколько точно ремонтник должен смотреть на цель, чтобы работать, в радианах (REPAIR_AIM).
	repairAim = 0.2,
	-- Обзор недостроенного: половина основания и ещё столько тайлов (SITE_SIGHT).
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

-- Расстояние от точки до прямоугольника; внутри — ноль (rectDistance).
local function rectDistance(left: number, top: number, width: number, height: number, x: number, y: number): number
	local dx = math.max(left - x, 0, x - left - width)
	local dy = math.max(top - y, 0, y - top - height)
	return math.sqrt(dx * dx + dy * dy)
end

type Work = { x: number, y: number, width: number, height: number, radius: number, cost: number }

-- Над чем здесь работают: стройка, разбор или починка; nil — работы нет (workAt). Прямоугольник основания в тайлах;
-- у юнита — точка в его центре и радиус.
local function workAt(ctx, e: number): Work?
	if not ctx:alive(e) then
		return nil
	end
	local kind = kinds.of(ctx, e)
	if not kind or not ctx:has(e, "Position") then
		return nil
	end
	local site = ctx:has(e, "Site")
	if not site and not construction.isRepairable(ctx, e) then
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
	return { x = x, y = y, width = size.width, height = size.height, radius = 0, cost = kind.data.cost }
end

-- Расстояние от точки до края работы; внутри основания — ноль.
local function distanceTo(work: Work, x: number, y: number): number
	return math.max(0, rectDistance(work.x, work.y, work.width, work.height, x, y) - work.radius)
end

-- Попадали ли по этому в последние repairPause секунд: такое не чинят и к нему не едут (underFire).
local function underFire(ctx, e: number, rules): boolean
	local health = ctx:get(e, "Health")
	if not health or health.hit < 0 then
		return false
	end
	return ctx.tick - health.hit < rules.repairPause / ctx.dt
end

-- Тайлы, где стоят юниты, кроме ignore: на них не встают (standingUnits). radius — запас вокруг.
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

-- Посылает своих ремонтников на стройку, разбор или чинить (assignBuilders). Чужие, без Repair и разворачивающиеся
-- выбрасываются; сам себя ремонтник не чинит.
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

-- Освобождает основание площадки и говорит, свободно ли оно (clearSite): свои стоящие с evict уходят, едущих не
-- трогают, чужих остаётся ждать.
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

-- Строитель занят работой, которую дал ему игрок, или ждёт приказов в очереди: новую стройку из меню он не бросает,
-- она встаёт ему в очередь (isBusyBuilder).
local isBusy = queue.busyBuilder

-- Стоит ли работа, хотя ремонтник до неё дотянулся: стройка вне зоны или с юнитами на ещё пустой площадке, починка —
-- без кредитов (isStalled).
local function isStalled(ctx, e: number, rules, purse, all): boolean
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

-- Над чем сейчас работает каждый ремонтник (repairLinks): над той работой, к которой его послали, если дотягивается,
-- а иначе — над ближайшей из тех, до которых дотягивается и которые не стоят.
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
		-- Ремонтная станция (repairStations): готовая, не выключенная и с энергией — чинит на свою долю энергии.
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
			-- Станция только чинит: стройки и разбор — работа строителя.
			if repairer.station and ctx:has(target.entity, "Site") then
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

-- Новые площадки по приказу игрока: с основания уходят свои, к ней едут строители, которых дали.
local function laid(ctx, player: number, site: number, builders: { number })
	if not ctx:alive(site) then
		return
	end
	clearSite(ctx, site, true)
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

-- Закладывает площадку вида kind левым верхним тайлом в (x, y) без проверок (orderBuild): материалы привезут
-- грузовики, трубы и строители. Номер известен сразу, а площадка появится после системы.
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

-- Убирает трубу, вместо которой кладут другую, сразу: заложенную — даром, начатую — с возвратом уплаченного, готовую — с
-- возвратом как за разбор (replacePipe).
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

mechanic.commands = {
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
	-- уже стоит, остаётся; пару кладут целиком или никак (orderWells).
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

	-- { tiles, builders, gate } — протянутая стена или ворота (orderWalls).
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

	-- { site } — отменить стройку (cancelBuild). Не начатая исчезает сразу; начатая разбирается, и уплаченное за неё
	-- возвращается по ходу разбора; отмена разбора оставляет здание целым. Разбор отменённой стройки не отменить.
	cancelBuild = function(ctx, player, args)
		local site = args.site
		if type(site) ~= "number" or not isOwn(ctx, player, site) then
			return
		end
		local state = ctx:get(site, "Site")
		if not state or state.undo then
			return
		end
		if state.demolish then
			ctx:remove(site, "Site")
			-- Разбор отменён: здание снова в сети.
			local link = buildings.link(kinds.of(ctx, site))
			if link then
				ctx:add(site, "Link", link)
			end
		elseif ctx:has(site, "Footprint") then
			ctx:set(site, "Site", { demolish = true, undo = true })
			-- Разбираемое материалов уже не ждёт.
			if ctx:has(site, "Link") then
				ctx:remove(site, "Link")
			end
		else
			-- Привезённые материалы остаются на земле.
			drops.cargo(ctx, site)
			ctx:destroy(site)
		end
	end,

	-- { building, builders } — разобрать своё готовое здание (demolish): разбирают строители, быстрее, чем строят;
	-- половина цены вернётся, когда разберут. С этого момента здание не работает и зону не расширяет.
	demolish = function(ctx, player, args)
		local building = args.building
		if type(building) ~= "number" or not ctx:alive(building) or not construction.canDemolish(ctx, player, building) then
			return
		end
		local total = construction.siteTicks(kinds.of(ctx, building), ctx.dt)
		ctx:add(building, "Site", { progress = total, total = total, demolish = true })
		ctx:remove(building, "Link")
		ctx:emit("laid", { site = building, player = player, builders = if type(args.builders) == "table" then args.builders else {} })
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
				local kind = kinds.of(ctx, e)
				local site = ctx:get(e, "Site")
				local player = ownerOf(ctx, e)
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
						wallet.add(purse, player, construction.refundOf(kind) + construction.prepaidOf(ctx, e))
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
				-- Дальше привезённых материалов стройка не идёт.
				local progress = math.min(site.progress, total * health.value / health.max)
				local reached = math.min(progress + count, total, total * construction.materialShare(ctx, e))
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

-- На клиенте: здание достроено — звук готового (worldSounds.ts); своё отвергнутое место — жужжание.
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
