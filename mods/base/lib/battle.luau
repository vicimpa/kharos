--!strict
-- Показательный бой двух армий — перенос battle.ts: случайная армия на бюджет (randomArmy), строй двух сторон
-- (spawnBattle) и ведение боя (driveBattle). На нём стоят боевые сценки витрины (scenes/).

local battle = {}

-- Учебный противник: против него воюют сценки (TRAINING_PLAYER).
battle.FOE = 9999
-- Сколько кредитов стоит армия одной стороны показательного боя.
battle.BUDGET = 3500
-- На сколько тайлов от точки встречи стоит передний ряд каждой стороны.
battle.GAP = 6
-- Шаг строя в тайлах и сколько колонн в глубину под него ищется место.
local SPACING = 2
local DEPTH = 200

local readf64 = buffer.readf64

local function at(column: buffer, i: number): number
	return readf64(column, (i - 1) * 8)
end

-- Вооружён ли вид: своим оружием или турелями с оружием (isFighter).
local function fighter(ctx, kind): boolean
	if kind.data.weapon then
		return true
	end
	for _, mount in kind.data.mounts or {} do
		local turret = ctx.protos.turrets[mount.turret]
		if turret and turret.data.weapon then
			return true
		end
	end
	return false
end

-- Боевые виды юнитов по именам — без машин снабжения: патронов в бою армий не тратят.
local function armed(ctx): { string }
	local list = {}
	for name, kind in ctx.protos.units do
		if fighter(ctx, kind) and not kind.data.supplies then
			table.insert(list, name)
		end
	end
	table.sort(list)
	return list
end

-- Случайная армия из боевых юнитов на budget кредитов: юниты добираются по одному, пока хватает на самого дешёвого
-- из разрешённых. weights — насколько часто берётся каждый вид: 0 — не берётся совсем, без веса — вес 1; если все
-- веса нулевые, виды равноправны.
function battle.randomArmy(ctx, budget: number?, weights: { [string]: number }?): { string }
	local left = budget or battle.BUDGET
	local given = weights or {}
	local function weightOf(name: string): number
		return math.max(0, given[name] or 1)
	end
	local kinds = armed(ctx)
	local any = false
	for _, name in kinds do
		any = any or weightOf(name) > 0
	end
	if any then
		local kept = {}
		for _, name in kinds do
			if weightOf(name) > 0 then
				table.insert(kept, name)
			end
		end
		kinds = kept
	else
		given = {}
	end
	local army = {}
	while true do
		local affordable = {}
		local total = 0
		for _, name in kinds do
			if ctx.protos.units[name].data.cost <= left then
				table.insert(affordable, name)
				total += weightOf(name)
			end
		end
		if #affordable == 0 then
			return army
		end
		local pick = ctx:random() * total
		local chosen = affordable[#affordable]
		for _, name in affordable do
			pick -= weightOf(name)
			if pick < 0 then
				chosen = name
				break
			end
		end
		table.insert(army, chosen)
		left -= ctx.protos.units[chosen].data.cost
	end
end

local function flies(ctx, name: string): boolean
	return ctx.protos.units[name].data.kind == "air"
end

-- Места для строя из count юнитов: колонны от тайла (x, y) в сторону side (-1 — влево, 1 — вправо), ближняя к
-- противнику заполняется первой, каждая — от середины к краям. Тайлы, где стоять нельзя, пропускаются.
local function formation(ctx, x: number, y: number, side: number, count: number, air: boolean): { number }
	local rows = math.max(3, math.ceil(math.sqrt(count * 2)))
	local tiles = {}
	local class = if air then "air" else "vehicle"
	local column = 0
	while column < DEPTH and #tiles < count * 2 do
		local row = 0
		while row < rows and #tiles < count * 2 do
			-- 0, 1, -1, 2, -2…
			local offset = if row % 2 == 1 then (row + 1) / 2 else -row / 2
			local tileX, tileY = x + side * column * SPACING, y + offset * SPACING
			if ctx:can_stand(class, tileX, tileY) then
				table.insert(tiles, tileX)
				table.insert(tiles, tileY)
			end
			row += 1
		end
		column += 1
	end
	return tiles
end

-- Отряд вида names игрока owner на тайлах tiles (x, y подряд). В сценках все агрессивны: увидел врага — идёт на
-- него; в обороне юнит под огнём издалека стоял бы и молчал (setStance — сразу при появлении).
function battle.spawn(ctx, names: { string }, owner: number, tiles: { number }): { number }
	local units = {}
	for i, name in names do
		if i * 2 > #tiles then
			break
		end
		local fields: { [string]: any } = { Position = { x = tiles[i * 2 - 1] + 0.5, y = tiles[i * 2] + 0.5 }, Owner = { player = owner } }
		if fighter(ctx, ctx.protos.units[name]) then
			fields.Tactics = { stance = "aggressive" }
		end
		table.insert(units, ctx:spawn("units/" .. name, fields))
	end
	return units
end

-- Показательный бой: две армии по обе стороны от тайла (x, y) — own игрока player слева, foe учебного противника
-- справа; передний ряд каждой — в gap тайлах от него. Сами они не сойдутся: вести их в бой должен drive.
function battle.spawnBattle(ctx, player: number, x: number, y: number, own: { string }, foe: { string }, gap: number?)
	for _, side in { { player, -1, own }, { battle.FOE, 1, foe } } do
		local owner, direction, army = side[1], side[2], side[3]
		for _, air in { false, true } do
			local names = {}
			for _, name in army do
				if flies(ctx, name) == air then
					table.insert(names, name)
				end
			end
			battle.spawn(ctx, names, owner, formation(ctx, x + direction * (gap or battle.GAP), y, direction, #names, air))
		end
	end
end

-- Оружие стрелка: вид из weapons/ или nil.
local function weaponOf(ctx, entity: number)
	local armedNow = ctx:get(entity, "Armed")
	return armedNow and ctx.protos.weapons[armedNow.weapon]
end

-- Ведёт показательный бой: каждому вооружённому юниту без цели указывает ближайшего врага, которого тот может
-- достать. false — бой кончился: у одной из сторон не осталось юнитов или ни одна не может достать другую.
function battle.drive(ctx, player: number): boolean
	local turrets: { [number]: { number } } = {}
	local mounts = ctx:query({ "Attached" })
	for i = 1, mounts.n do
		local parent = at(mounts.Attached.parent, i)
		turrets[parent] = turrets[parent] or {}
		table.insert(turrets[parent], at(mounts.entity, i))
	end
	local q = ctx:query({ "Mover", "Position", "Owner" })
	local units = {}
	for i = 1, q.n do
		local entity = at(q.entity, i)
		local gunners = { entity }
		for _, turret in turrets[entity] or {} do
			table.insert(gunners, turret)
		end
		local hitsGround, hitsAir = false, false
		for _, gunner in gunners do
			local weapon = weaponOf(ctx, gunner)
			if weapon then
				hitsAir = hitsAir or weapon.data.air == true
				hitsGround = hitsGround or not weapon.data.onlyAir
			end
		end
		table.insert(units, {
			entity = entity,
			player = at(q.Owner.player, i),
			x = at(q.Position.x, i),
			y = at(q.Position.y, i),
			air = ctx:text(at(q.Mover.class, i)) == "air",
			hitsGround = hitsGround,
			hitsAir = hitsAir,
			gunners = gunners,
		})
	end
	-- Свободен тот, кто стоит, а ни у него, ни у его турелей нет живой цели. Идущего не трогают.
	for _, self in units do
		if ctx:has(self.entity, "Path") or not (self.hitsGround or self.hitsAir) then
			continue
		end
		local targets, alive = 0, false
		for _, gunner in self.gunners do
			local armedNow = ctx:get(gunner, "Armed")
			if armedNow then
				targets += 1
				if armedNow.target >= 0 and ctx:has(armedNow.target, "Position") then
					alive = true
				end
			end
		end
		if targets == 0 or alive then
			continue
		end
		local nearest, best = nil, math.huge
		for _, other in units do
			if other.player == self.player or not (if other.air then self.hitsAir else self.hitsGround) then
				continue
			end
			local distance = (other.x - self.x) ^ 2 + (other.y - self.y) ^ 2
			if distance < best then
				best = distance
				nearest = other.entity
			end
		end
		if nearest then
			ctx:attack(self.player, { self.entity }, nearest)
		end
	end
	-- Кто-то из одной стороны может достать кого-то из другой: наземного бьёт любое оружие, летающего — только air.
	local own, foe, reaches = false, false, false
	for _, from in units do
		own = own or from.player == player
		foe = foe or from.player ~= player
		for _, to in units do
			if from.player ~= to.player and (if to.air then from.hitsAir else from.hitsGround) then
				reaches = true
			end
		end
	end
	return own and foe and reaches
end

-- Сценка витрины — бой двух армий одной цены; weights — из кого они набираются. Виды, которых нет в weights, не
-- берутся (NONE в showcase.ts), а без weights — все боевые.
function battle.scene(budget: number, weights: { [string]: number }?)
	local scene = {}
	function scene.create(ctx, player: number): boolean
		local only = weights and battle.only(ctx, weights)
		battle.spawnBattle(ctx, player, 0, 0, battle.randomArmy(ctx, budget, only), battle.randomArmy(ctx, budget, only))
		return true
	end
	function scene.drive(ctx, player: number): boolean
		return battle.drive(ctx, player)
	end
	return scene
end

-- Веса, где берутся только названные виды: остальным — ноль.
function battle.only(ctx, weights: { [string]: number }): { [string]: number }
	local all = {}
	for name in ctx.protos.units do
		all[name] = weights[name] or 0
	end
	return all
end

return battle
