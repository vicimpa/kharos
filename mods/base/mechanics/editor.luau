--!strict
-- Правки редактора — перенос editor.ts и editOps.ts: режим бога. Мир в редакторе стоит (тиков нет), приказ `edit`
-- хост выполняет сразу; правки не проверяются на деньги, технологии и строителей, но правила места — те же, что в игре:
-- здание не встаёт туда, где его нельзя построить, юнит — туда, где ему не стоять. Правка — { op, ... }, как EditOp;
-- что не удалось, уходит сигналом edit_failed с причиной (раздел host словаря TS).

local deposits = require("lib/deposits")
local editor = require("lib/editor")
local goods = require("lib/goods")
local kinds = require("lib/kinds")
local placement = require("lib/placement")
local scenery = require("lib/scenery")
local tactics = require("lib/tactics")
local queue = require("lib/queue")

local mechanic = {}

local ROCK, SAND, MOUNTAIN = 2, 1, 3
local CLIFF_BIT, DUNE_SHIFT = 4, 5
local PEAK_RADIUS_SCALE = 4

-- Турели встают на носители: мир стоит, ставит их система движка сразу (settle).
local function settle(ctx)
	ctx:engine("follow")
end

local function failed(ctx, reason: string)
	ctx:signal("edit_failed", { reason = reason })
end

-- Живые сущности из списка номеров.
local function alive(ctx, list): { number }
	local found = {}
	for _, id in (if type(list) == "table" then list else {}) do
		if type(id) == "number" and ctx:alive(id) then
			table.insert(found, id)
		end
	end
	return found
end

-- Заводит игрока, если его ещё нет (addCredits(…, 0) в TS): у него есть Player.
local function ensurePlayer(ctx, player: number)
	if player <= 0 then
		return
	end
	for _, e in ctx:each({ "Player" }) do
		if ctx:get(e, "Player").id == player then
			return
		end
	end
	-- Игрок без стартового набора и без кредитов (addCredits(…, 0)): сущность Player, как у mechanics/players.
	local list = ctx.storage.players or {}
	ctx.storage.players = list
	list[tostring(player)] = ctx:spawn(nil, { Player = { id = player, credits = 0 } })
	ctx:flush()
end

local function playerEntity(ctx, player: number): number?
	for _, e in ctx:each({ "Player" }) do
		if ctx:get(e, "Player").id == player then
			return e
		end
	end
	return nil
end

-- Хранимые байты тайла не-горы (setTile): вид, биом, ярус, кромка, барханы (только у песка).
local function tileBytes(terrain: number, biome: number, tier: number, cliff: boolean, dunes: number): { number }
	local dune = if terrain == SAND then bit32.lshift(dunes, DUNE_SHIFT) else 0
	return { terrain, biome, 0, bit32.bor(bit32.band(tier, 3), if cliff then CLIFF_BIT else 0, dune) }
end

-- Красит кистью тайлы вокруг (x, y) (paint): правка — сразу правда для всех. Гору, которую кисть задела хоть краем,
-- стирает целиком; гора кисти — одна вершина в середине, стыкуется с соседними грядой.
local function paint(ctx, x: number, y: number, size: number, brush)
	local edits = {}
	local function put(tx: number, ty: number, bytes: { number })
		table.move({ tx, ty, bytes[1], bytes[2], bytes[3], bytes[4] }, 1, 6, #edits + 1, edits)
	end
	local function biomeByte(packed: number): number
		return if brush.biome == nil then packed else bit32.bor(bit32.lshift(brush.biome, 6), bit32.lshift(brush.biome, 4))
	end
	if brush.terrain == MOUNTAIN then
		local peak = { x = x + 0.5, y = y + 0.5, radius = math.max(0.7, math.min(editor.MAX_PEAK_RADIUS, size / 2)) }
		local span = math.ceil(peak.radius + 1)
		for ty = y - span, y + span do
			for tx = x - span, x + span do
				local cx, cy = tx + 0.5, ty + 0.5
				if not editor.inside(ctx, tx, ty) or math.sqrt((peak.x - cx) ^ 2 + (peak.y - cy) ^ 2) >= peak.radius + math.sqrt(0.5) then
					continue
				end
				local px, py = ctx:peak(tx, ty)
				if px and math.sqrt((px - cx) ^ 2 + (py - cy) ^ 2) < math.sqrt((peak.x - cx) ^ 2 + (peak.y - cy) ^ 2) then
					continue
				end
				local _, packed = ctx:tile(tx, ty)
				local dx = math.round((peak.x - cx) * 2 + 8)
				local dy = math.round((peak.y - cy) * 2 + 8)
				if dx >= 0 and dx <= 15 and dy >= 0 and dy <= 15 then
					put(tx, ty, { MOUNTAIN, biomeByte(packed), math.round(math.min(peak.radius, PEAK_RADIUS_SCALE) / PEAK_RADIUS_SCALE * 255), bit32.bor(bit32.lshift(dx, 4), dy) })
				end
			end
		end
		ctx:edit_tiles(edits, true)
		return
	end
	local tiles = editor.brushTiles(x, y, size, brush.shape, function()
		return ctx:random()
	end)
	-- Горы, задетые кистью, — скалой целиком: кусок горы остался бы обрубком.
	local erased = {}
	for i = 1, #tiles - 1, 2 do
		local px, py, radius = ctx:peak(tiles[i], tiles[i + 1])
		if px and not erased[px .. ":" .. py] then
			erased[px .. ":" .. py] = true
			local tile = require("lib/earthworks").peakTiles(ctx, { x = px, y = py, radius = radius })
			for j = 1, #tile - 1, 2 do
				local _, packed = ctx:tile(tile[j], tile[j + 1])
				put(tile[j], tile[j + 1], tileBytes(ROCK, packed, 1, false, 0))
			end
		end
	end
	ctx:edit_tiles(edits, true)
	edits = {}
	for i = 1, #tiles - 1, 2 do
		local tx, ty = tiles[i], tiles[i + 1]
		if not editor.inside(ctx, tx, ty) then
			continue
		end
		local terrain, packed, _, relief = ctx:tile(tx, ty)
		local kind = if brush.terrain ~= nil then brush.terrain else terrain
		local tier = if brush.tier ~= nil then brush.tier else bit32.band(relief, 3)
		local cliff = if brush.cliff ~= nil then brush.cliff else bit32.band(relief, CLIFF_BIT) ~= 0
		local dunes = if brush.dunes ~= nil then brush.dunes else bit32.band(bit32.rshift(relief, DUNE_SHIFT), 3)
		put(tx, ty, tileBytes(kind, biomeByte(packed), tier, cliff, dunes))
	end
	ctx:edit_tiles(edits, true)
end

-- Убирает здание или юнит вместе с его турелями, без взрыва и без груза на земле (erase).
local function erase(ctx, e: number)
	if not ctx:alive(e) or ctx:has(e, "Attached") then
		return
	end
	for _, turret in editor.turretsOf(ctx, e) do
		ctx:destroy(turret)
	end
	ctx:destroy(e)
end

-- Переставляет здание: занятость тайлов и сети следят за составом мира, а не за местом — снять и вернуть основание и
-- связь (resetZones).
local function rebuild(ctx, e: number)
	local footprint, link = ctx:get(e, "Footprint"), ctx:get(e, "Link")
	if footprint then
		ctx:remove(e, "Footprint")
	end
	if link then
		ctx:remove(e, "Link")
	end
	ctx:flush()
	if footprint then
		ctx:add(e, "Footprint", footprint)
	end
	if link then
		ctx:add(e, "Link", link)
	end
	ctx:flush()
end

-- Ставит юнит вида name игроку player на тайл (x, y), если ему там стоять (putUnit).
local function canPut(ctx, name: string, x: number, y: number): boolean
	local unit = ctx.protos.units[name]
	if not unit then
		return false
	end
	local class = unit.data.kind or "vehicle"
	if class == "air" then
		return editor.inside(ctx, x, y)
	end
	return ctx:can_stand(if class == "infantry" then "infantry" else "vehicle", x, y)
end

-- Сдвигает юниты, здания и месторождения вместе на (dx, dy) тайлов: всё или ничего (moveGroup).
local function moveGroup(ctx, entities: { number }, dx: number, dy: number, spots: { editor.Spot }): boolean
	if dx == 0 and dy == 0 then
		return true
	end
	local moving = {}
	for _, e in entities do
		moving[e] = true
	end
	local ignore = {}
	for _, spot in spots do
		ignore[spot.entity] = true
	end
	for _, spot in spots do
		if not editor.canPutDeposit(ctx, spot.x + dx, spot.y + dy, ignore) then
			return false
		end
	end
	-- Друг другу сдвигаемые не мешают: места, откуда они уйдут, — свободны.
	local view = setmetatable({
		occupant = function(_, x: number, y: number)
			local found = ctx:occupant(x, y)
			return if found and moving[found] then nil else found
		end,
	}, {
		__index = function(_, key: string)
			local value = ctx[key]
			if type(value) == "function" then
				return function(_, ...)
					return value(ctx, ...)
				end
			end
			return value
		end,
	})
	for _, e in entities do
		local at = ctx:get(e, "Position")
		local kind = kinds.of(ctx, e)
		if ctx:has(e, "Building") and kind then
			local left, top = placement.left(at.x, kind.data.width), placement.left(at.y, kind.data.height)
			if not placement.canPlace(view, kind, left + dx, top + dy) then
				return false
			end
		elseif ctx:has(e, "Mover") and kind and not canPut(ctx, kind.name, math.floor(at.x + dx), math.floor(at.y + dy)) then
			return false
		end
	end
	for _, e in entities do
		local at = ctx:get(e, "Position")
		ctx:set(e, "Position", { x = at.x + dx, y = at.y + dy })
		ctx:remove(e, "Path")
	end
	for _, spot in spots do
		local at = ctx:get(spot.entity, "Position")
		ctx:set(spot.entity, "Position", { x = at.x + dx, y = at.y + dy })
	end
	ctx:flush()
	for _, e in entities do
		if ctx:has(e, "Building") then
			rebuild(ctx, e)
		end
	end
	settle(ctx)
	return true
end

-- Месторождения по левым верхним тайлам.
local function spotsAt(ctx, list): { editor.Spot }
	local found = {}
	for _, at in (if type(list) == "table" then list else {}) do
		local spot = type(at) == "table" and editor.depositAt(ctx, at.x, at.y)
		if spot then
			table.insert(found, spot)
		end
	end
	return found
end

local function spawnDeposit(ctx, x: number, y: number, kind: string, reserve: number)
	ctx:spawn("deposits/" .. kind, {
		Position = { x = x + deposits.SIZE / 2, y = y + deposits.SIZE / 2 },
		Deposit = { reserve = math.max(0, math.round(reserve)), total = math.max(0, math.round(reserve)) },
	})
	ctx:flush()
end

-- Правки по имени (applyEdit).
local OPS = {
	paint = function(ctx, edit)
		paint(ctx, math.floor(edit.x), math.floor(edit.y), math.max(1, math.floor(edit.size or 1)), edit.brush or {})
	end,
	building = function(ctx, edit)
		local kind = ctx.protos.buildings[edit.type]
		if not kind or not scenery.canPlace(ctx, edit.type, edit.x, edit.y) then
			return failed(ctx, "building")
		end
		ensurePlayer(ctx, edit.player or 0)
		scenery.place(ctx, edit.type, edit.x, edit.y, edit.player or 0)
		settle(ctx)
	end,
	unit = function(ctx, edit)
		if not canPut(ctx, edit.type, edit.x, edit.y) then
			return failed(ctx, "unit")
		end
		ensurePlayer(ctx, edit.player or 0)
		ctx:spawn("units/" .. edit.type, { Position = { x = edit.x + 0.5, y = edit.y + 0.5 }, Owner = { player = edit.player or 0 } })
		ctx:flush()
		settle(ctx)
	end,
	deposit = function(ctx, edit)
		if not ctx.protos.deposits[edit.kind] or not editor.canPutDeposit(ctx, edit.x, edit.y) then
			return failed(ctx, "deposit")
		end
		spawnDeposit(ctx, edit.x, edit.y, edit.kind, edit.reserve or 0)
	end,
	setDeposit = function(ctx, edit)
		for _, spot in spotsAt(ctx, edit.spots) do
			local kind = if edit.kind and ctx.protos.deposits[edit.kind] then edit.kind else spot.kind
			local left = if type(edit.left) == "number" then edit.left else spot.left
			if kind == spot.kind then
				ctx:set(spot.entity, "Deposit", { reserve = math.max(0, math.round(left)), total = math.max(0, math.round(left)) })
			else
				ctx:destroy(spot.entity)
				ctx:flush()
				spawnDeposit(ctx, spot.x, spot.y, kind, left)
			end
		end
		ctx:flush()
	end,
	removeDeposit = function(ctx, edit)
		for _, spot in spotsAt(ctx, edit.spots) do
			ctx:destroy(spot.entity)
		end
		ctx:flush()
	end,
	erase = function(ctx, edit)
		for _, e in alive(ctx, edit.entities) do
			erase(ctx, e)
		end
		ctx:flush()
	end,
	move = function(ctx, edit)
		if not moveGroup(ctx, alive(ctx, edit.entities), math.floor(edit.dx or 0), math.floor(edit.dy or 0), spotsAt(ctx, edit.deposits)) then
			failed(ctx, "move")
		end
	end,
	owner = function(ctx, edit)
		local player = edit.player or 0
		ensurePlayer(ctx, player)
		for _, e in alive(ctx, edit.entities) do
			for _, target in { e, table.unpack(editor.turretsOf(ctx, e)) } do
				if ctx:has(target, "Owner") then
					ctx:set(target, "Owner", { player = player })
				end
			end
			ctx:flush()
			if ctx:has(e, "Building") then
				rebuild(ctx, e)
			end
		end
	end,
	health = function(ctx, edit)
		for _, e in alive(ctx, edit.entities) do
			local health = ctx:get(e, "Health")
			if health then
				ctx:set(e, "Health", { value = health.max * math.clamp(edit.share or 1, 0.01, 1) })
			end
		end
		ctx:flush()
	end,
	facing = function(ctx, edit)
		for _, e in alive(ctx, edit.entities) do
			if ctx:has(e, "Mover") then
				ctx:set(e, "Facing", { angle = edit.angle or 0 })
			end
		end
		ctx:flush()
		settle(ctx)
	end,
	turret = function(ctx, edit)
		for _, e in alive(ctx, edit.entities) do
			local base = ctx:get(e, "Facing")
			for i, turret in editor.turretsOf(ctx, e) do
				if edit.index == nil or edit.index == i - 1 then
					ctx:set(turret, "Attached", { angle = (edit.angle or 0) - (if base then base.angle else 0) })
				end
			end
		end
		ctx:flush()
		settle(ctx)
	end,
	stock = function(ctx, edit)
		local stock = type(edit.entity) == "number" and ctx:alive(edit.entity) and ctx:get(edit.entity, "Inventory")
		if not stock or type(edit.good) ~= "string" or not table.find(goods.names(ctx), edit.good) then
			return
		end
		local items = table.clone(stock.items)
		local value = math.max(0, math.round(edit.amount or 0))
		items[edit.good] = if value > 0 then value else nil
		ctx:set(edit.entity, "Inventory", { items = items })
		ctx:flush()
	end,
	clearTasks = function(ctx, edit)
		local units = alive(ctx, edit.entities)
		queue.forget(ctx, units)
		for _, e in units do
			ctx:remove(e, "Path")
			ctx:remove(e, "Builds")
			tactics.stopAttack(ctx, e)
			tactics.clear(ctx, e)
		end
		ctx:emit("release", { units = units })
		ctx:flush()
	end,
	order = function(ctx, edit)
		local command = type(edit.command) == "table" and edit.command
		local handler = command and type(command.type) == "string" and require("mechanics/orders").handler(ctx, command.type)
		if not handler then
			return failed(ctx, "order")
		end
		handler(ctx, edit.player or 0, command)
		ctx:flush()
		settle(ctx)
	end,
	credits = function(ctx, edit)
		local player = edit.player or 0
		ensurePlayer(ctx, player)
		local e = playerEntity(ctx, player)
		if e then
			ctx:set(e, "Player", { credits = math.max(0, math.round(edit.amount or 0)), earned = 0 })
			ctx:flush()
		end
	end,
	camera = function(ctx, edit)
		local player = edit.player or 0
		if player <= 0 then
			return
		end
		ensurePlayer(ctx, player)
		local e = playerEntity(ctx, player)
		local camera = edit.camera
		if e then
			ctx:set(e, "Player", { camera = if type(camera) == "table" then { camera.x, camera.y, camera.zoom } else {} })
			ctx:flush()
		end
	end,
	addPlayer = function(ctx)
		local players = editor.players(ctx)
		ensurePlayer(ctx, (players[#players] or 0) + 1)
	end,
}

mechanic.commands = {
	-- { op, ... } — правка редактора (EditOp): от любого игрока, это бог.
	edit = function(ctx, _player, args)
		local run = type(args) == "table" and OPS[args.op]
		if run then
			run(ctx, args)
		end
	end,
}

-- Почему правка не удалась — строкой панели (раздел host словаря TS).
local REASONS = {
	building = "Здание сюда не встанет",
	unit = "Юнит здесь не встанет",
	deposit = "Месторождение ложится на скалу не у подножия обрыва и не внахлёст с другим",
	move = "Сюда не сдвинуть",
	order = "Приказ не принят",
}

-- На клиенте: ответ правки — в строку состояния панели редактора (ui/editor).
mechanic.signals = {
	edit_failed = function(c, signal)
		c.shared.editorStatus = REASONS[signal.reason] or signal.reason
	end,
}

return mechanic
