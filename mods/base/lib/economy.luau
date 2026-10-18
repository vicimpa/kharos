--!strict
-- Хозяйство энергосетей — перенос income.ts, общий хосту (ctx) и клиенту (c): сколько энергии сеть даёт и просит,
-- на какую долю работают потребители, перегруз электростанций, доход и подмога главного здания. Энергосети считает
-- движок (w:grids()): связные здания игрока, слитые по касанию кругов; энергия у каждой своя. Что меняет мир —
-- накопители, метка «занят», доход и износ — mechanics/economy.
--
-- Пока нет: реакторов (стержни горят с В8 — до тех пор реактор энергии не даёт), уровней зданий (улучшения), дохода игроку не в сети (сетевой хост).

local kinds = require("lib/kinds")
local levels = require("lib/levels")

local economy = {}

-- Подмога главного здания: пока у игрока меньше RELIEF_BELOW кредитов, одно его главное здание даёт RELIEF_INCOME в
-- секунду вместо обычного дохода.
economy.RELIEF_BELOW = 600
economy.RELIEF_INCOME = 1
-- Какую долю своей энергии просит потребитель, которому нечего делать (IDLE_SHARE).
economy.IDLE_SHARE = 1 / 3
-- Какую долю прочности в секунду теряет электростанция, когда полная нагрузка вдвое больше выработки (OVERLOAD_DAMAGE).
economy.OVERLOAD_DAMAGE = 0.01
-- Главное здание: без него в сети генераторы материи дохода не приносят (CORE).
economy.CORE = "command"

export type Economy = {
	-- Выработка (с отданным накопителями) и спрос: работающий потребитель просит всю свою энергию, стоящий — меньше.
	produced: number,
	demand: number,
	-- Полная нагрузка: сколько попросили бы потребители, работай они все. По ней судят о перегрузе.
	peak: number,
	-- Сколько ещё накопители могли бы отдать в этот тик сверх отданного.
	spare: number,
	-- Доход в кредитах в секунду с учётом нехватки энергии.
	income: number,
	-- Сколько в сети тесных зданий (data.crowding).
	crowd: number,
	-- Сколько энергии отдают сети её накопители в этот тик.
	stored: number,
}

export type Book = { player: number, grid: { player: number, members: { number }, circles: { number } }, economy: Economy }

local function blank(): Economy
	return { produced = 0, demand = 0, peak = 0, spare = 0, income = 0, crowd = 0, stored = 0 }
end

-- Сколько энергии просит без дела потребитель, которому в работе нужно power (меньше нуля): треть, целым числом в
-- большую сторону (idlePower).
function economy.idlePower(power: number): number
	return -math.ceil(-power * economy.IDLE_SHARE)
end

-- Потребитель без простоя: пока включён, работает — генератор материи, радар (alwaysBusy).
function economy.alwaysBusy(data): boolean
	return (data.income ~= nil and data.income ~= 0) or (data.scan ~= nil and data.scan ~= 0)
end

-- Можно ли здание вида kind выключать: потребитель энергии или реактор (isSwitchable).
function economy.switchable(kind): boolean
	return (kind.data.power or 0) < 0 or kind.data.burns ~= nil
end

-- Выключил ли игрок потребителя (switchedOff): у цеха — свой флаг.
function economy.switchedOff(w, e: number): boolean
	local assembly = w:get(e, "Assembly")
	if assembly then
		return not assembly.on
	end
	return w:has(e, "Off")
end

-- Своё готовое выключенное здание (shutDown): так оно и показано — темнее и со значком.
function economy.shutDown(w, player: number, e: number): boolean
	local owner = w:get(e, "Owner")
	return owner ~= nil and owner.player == player and not w:has(e, "Site") and economy.switchedOff(w, e)
end

-- Горит ли в реакторе стержень (isBurning): тогда он вырабатывает энергию. У других зданий — false.
function economy.burning(w, e: number): boolean
	local reactor = w:get(e, "Reactor")
	return reactor ~= nil and reactor.left > 0 and not w:has(e, "Off")
end

-- Сколько энергии даёт (больше нуля) или просит (меньше) здание (powerAt). Реактор — только пока горит стержень.
-- Выработка растёт с уровнем; у радара — потребление: дальше разведывает — больше ест.
function economy.powerAt(w, e: number, kind): number
	local data = kind.data
	if data.burns then
		return if economy.burning(w, e) then data.power or 0 else 0
	end
	local power = data.power or 0
	return if power > 0 or data.scan then power * levels.factorOf(w, e) else power
end

-- Приносит ли вид доход только при главном здании в сети: все доходные, кроме самого главного (needsCore).
local function needsCore(kind): boolean
	return kind.name ~= economy.CORE and (kind.data.income or 0) ~= 0
end

local function hasCore(w, members: { number }): boolean
	local first = members[1]
	local kind = first and kinds.of(w, first)
	return kind ~= nil and kind.name == economy.CORE
end

-- Хозяйство энергосети (economyOfZone). stored — считать ли то, что отдают накопители: сами они решают, сколько отдать,
-- по хозяйству без себя.
function economy.ofGrid(w, members: { number }, stored: boolean): Economy
	local result = blank()
	local core = hasCore(w, members)
	local step = w.step
	-- Доход потребителей при полной энергии.
	local powered = 0
	for _, e in members do
		local kind = kinds.of(w, e)
		if not kind then
			continue
		end
		local data = kind.data
		local battery = if stored then w:get(e, "Accumulator") else nil
		local flow = if battery then battery.flow else 0
		if flow > 0 then
			result.stored += flow
		end
		-- Заряженный накопитель мог бы отдать ещё: под полную нагрузку этот запас считается.
		if battery and data.battery then
			result.spare += math.max(0, math.min(data.battery.rate - math.max(0, flow), battery.charge / step))
		end
		local power = economy.powerAt(w, e, kind)
		local income = if core or not needsCore(kind) then data.income or 0 else 0
		-- Выключенный потребитель энергии не просит и ничего не даёт.
		if power < 0 and economy.switchedOff(w, e) then
			continue
		end
		-- Повреждённая электростанция даёт энергии во столько же раз меньше, во сколько упала её прочность.
		if power > 0 then
			local health = w:get(e, "Health")
			result.produced += power * (if health then health.value else 1)
		end
		if power < 0 then
			-- Тесное здание просит тем больше, чем их уже в сети: первое — одну норму, второе — две, третье — три.
			local norms = 1
			if data.crowding then
				result.crowd += 1
				norms = result.crowd
			end
			result.peak -= power * norms
			result.demand -= (if economy.alwaysBusy(data) or w:has(e, "Busy") then power else economy.idlePower(power)) * norms
			powered += income
		else
			result.income += income
		end
	end
	result.produced += result.stored
	if powered ~= 0 then
		result.income += powered * math.min(1, result.produced / result.demand)
	end
	return result
end

-- Кредиты игрока; нет такого — ноль.
local function creditsOf(w, player: number): number
	for _, e in w:each({ "Player" }) do
		local state = w:get(e, "Player")
		if state.id == player then
			return state.credits
		end
	end
	return 0
end

-- Хозяйства идущего тика: считаются раз на тик и мир, а не каждым, кто спросил (openBooks). У хоста мир — его память
-- (storage), у клиента — номер пересчёта сетей.
local cache: { key: any, tick: number, version: number, books: { Book }, supply: { [number]: number }? }? = nil

-- Забыть посчитанное в этом тике: накопители решили, сколько отдают, — хозяйства другие.
function economy.reopen()
	cache = nil
end

-- Энергосети всех игроков с их хозяйствами, у каждого игрока — по порядку сетей (books). Подмога — первой сети с
-- главным зданием.
function economy.books(w): { Book }
	local key = if w.storage ~= nil then w.storage else w.protos
	local version = w:network_version()
	local found = cache
	if found and found.key == key and found.tick == w.tick and found.version == version then
		return found.books
	end
	local result: { Book } = {}
	local relief: { [number]: number } = {}
	local command = w.protos.buildings[economy.CORE]
	local base = command and command.data.income or 0
	for _, grid in w:grids() do
		local player = grid.player
		if relief[player] == nil then
			relief[player] = if creditsOf(w, player) < economy.RELIEF_BELOW then economy.RELIEF_INCOME - base else 0
		end
		local book = economy.ofGrid(w, grid.members, true)
		if relief[player] > 0 and hasCore(w, grid.members) then
			book.income += relief[player]
			relief[player] = 0
		end
		table.insert(result, { player = player, grid = grid, economy = book })
	end
	cache = { key = key, tick = w.tick, version = version, books = result }
	return result
end

-- Хозяйства сетей одного игрока по порядку (zoneEconomies).
function economy.zones(w, player: number): { Economy }
	local list = {}
	for _, book in economy.books(w) do
		if book.player == player then
			table.insert(list, book.economy)
		end
	end
	return list
end

-- Итог по всем сетям игрока (economyOf): для дохода — то, что он получает, энергию так складывать — только для справки.
function economy.of(w, player: number): Economy
	local total = blank()
	for _, book in economy.books(w) do
		if book.player == player then
			for field, value in book.economy :: any do
				(total :: any)[field] += value
			end
		end
	end
	return total
end

-- Номер энергосети здания среди сетей его игрока и её хозяйство; не в сети — nil.
function economy.gridOf(w, e: number): (number?, Economy?)
	local index = 0
	local owner = w:get(e, "Owner")
	for _, book in economy.books(w) do
		if owner and book.player == owner.player then
			index += 1
			if table.find(book.grid.members, e) then
				return index, book.economy
			end
		end
	end
	return nil, nil
end

-- Как здание вида kind изменит баланс энергии сети с хозяйством e (powerOf): тесное просит за всех тесных.
function economy.powerOf(kind, e: Economy): number
	local power = kind.data.power or 0
	return if power < 0 and kind.data.crowding then power * (e.crowd + 1) else power
end

-- То же для здания без дела (idlePowerOf).
function economy.idlePowerOf(kind, e: Economy): number
	local power = kind.data.power or 0
	if power >= 0 or economy.alwaysBusy(kind.data) then
		return economy.powerOf(kind, e)
	end
	return economy.idlePower(power) * (if kind.data.crowding then e.crowd + 1 else 1)
end

-- Насколько сеть перегружена (overloadOf): 0 — энергии хватает и на полную нагрузку, 1 — полная нагрузка вдвое больше
-- того, что есть с запасом накопителей, и выше.
function economy.overloadOf(e: Economy): number
	local able = e.produced + e.spare
	return if e.produced > 0 and e.peak > able then math.min(1, e.peak / able - 1) else 0
end

-- Здания, которым не хватает энергии (powerStates): электростанция — "overload", потребитель — "starved".
function economy.states(w): { [number]: string }
	local states = {}
	for _, book in economy.books(w) do
		local e = book.economy
		local overloaded = economy.overloadOf(e) > 0
		local short = e.demand > e.produced
		if not overloaded and not short then
			continue
		end
		for _, member in book.grid.members do
			local kind = kinds.of(w, member)
			local power = if kind then economy.powerAt(w, member, kind) else 0
			if power > 0 and overloaded then
				states[member] = "overload"
			elseif power < 0 and short and not economy.switchedOff(w, member) then
				states[member] = "starved"
			end
		end
	end
	return states
end

-- На какую долю от полной скорости работает каждый потребитель энергии (powerSupply): 1 — хватает. Вне энергосети и
-- выключенного здесь нет — он не работает.
function economy.supply(w): { [number]: number }
	local books = economy.books(w)
	local found = cache
	if found and found.supply then
		return found.supply
	end
	local supply = {}
	for _, book in books do
		local e = book.economy
		local share = if e.demand > 0 then math.min(1, e.produced / e.demand) else 1
		for _, member in book.grid.members do
			local kind = kinds.of(w, member)
			if kind and economy.powerAt(w, member, kind) < 0 and not economy.switchedOff(w, member) then
				supply[member] = share
			end
		end
	end
	if found then
		found.supply = supply
	end
	return supply
end

-- Доля работы здания: потребителю — его доля энергии (вне сети и выключенному — ноль), остальным — 1.
function economy.shareOf(w, e: number): number
	local kind = kinds.of(w, e)
	if not kind or (kind.data.power or 0) >= 0 or not w:has(e, "Building") then
		return 1
	end
	return economy.supply(w)[e] or 0
end

-- Здания, которые принесли бы доход, но стоят в сети без главного здания (coreless).
function economy.coreless(w): { [number]: boolean }
	local idle = {}
	for _, book in economy.books(w) do
		if hasCore(w, book.grid.members) then
			continue
		end
		for _, member in book.grid.members do
			local kind = kinds.of(w, member)
			if kind and needsCore(kind) then
				idle[member] = true
			end
		end
	end
	return idle
end

-- Электростанции, которым есть что питать (loadedPlants): в каждой сети — столько, сколько нужно на её спрос сверх
-- отданного накопителями, начиная с ближайших к середине потребителей. Только картинка: энергия у сети общая.
function economy.loadedPlants(w): { [number]: boolean }
	local loaded = {}
	for _, book in economy.books(w) do
		local need = book.economy.demand - book.economy.stored
		if need <= 1e-9 then
			continue
		end
		local x, y, count = 0, 0, 0
		local plants = {}
		for _, member in book.grid.members do
			local kind = kinds.of(w, member)
			local power = if kind then economy.powerAt(w, member, kind) else 0
			if power == 0 or (power < 0 and economy.switchedOff(w, member)) then
				continue
			end
			local at = w:get(member, "Position")
			if power > 0 then
				local health = w:get(member, "Health")
				table.insert(plants, { entity = member, output = power * (if health then health.value else 1), x = at.x, y = at.y })
			else
				x += at.x
				y += at.y
				count += 1
			end
		end
		if count == 0 then
			continue
		end
		x /= count
		y /= count
		for _, plant in plants do
			plant.distance = math.sqrt((plant.x - x) ^ 2 + (plant.y - y) ^ 2)
		end
		table.sort(plants, function(a, b)
			if a.distance ~= b.distance then
				return a.distance < b.distance
			end
			return a.entity < b.entity
		end)
		for _, plant in plants do
			if need <= 1e-9 then
				break
			end
			loaded[plant.entity] = true
			need -= plant.output
		end
	end
	return loaded
end

-- Электростанции сетей, где энергии не хватило бы и целым станциям (overbuiltPlants): чинить такие бесполезно, пока
-- перегруз не снят.
function economy.overbuilt(w): { [number]: boolean }
	local plants = {}
	for _, book in economy.books(w) do
		local found, capacity = {}, 0
		for _, member in book.grid.members do
			local kind = kinds.of(w, member)
			local power = if kind then economy.powerAt(w, member, kind) else 0
			if power > 0 then
				table.insert(found, member)
				capacity += power
			end
		end
		if book.economy.peak > capacity + book.economy.spare then
			for _, member in found do
				plants[member] = true
			end
		end
	end
	return plants
end

return economy
