--!strict
-- Тестовая карта — перенос sandbox.ts: готовая база игрока у ближайшего к началу мира месторождения металла. Шахта,
-- главное здание, переработка, цеха, хранилища с запасом всего готового, космопорт, электростанции и заводы уже стоят,
-- соединены трубами; грузовики работают на заявки зон. Есть строители, немного войск и кредитов. На ней стоит сценка
-- витрины «добыча» (scenes/mining). Только хосту.

local deposits = require("lib/deposits")
local goods = require("lib/goods")
local scenery = require("lib/scenery")
local kinds = require("lib/kinds")

local sandbox = {}

sandbox.data = {
	-- Сколько кредитов у игрока (SANDBOX_CREDITS) и что уже лежит в хранилищах (SANDBOX_STOCK).
	credits = 10000,
	stock = { metal = 120, silicon = 40, fuel = 30, kharite = 12, blocks = 20, ammo = 60, parts = 30 },
	-- Насколько далеко от начала мира ищется месторождение под базу, в клетках месторождений (SEARCH_CELLS).
	searchCells = 6,
	-- Сколько тайлов вокруг шахты оставлено свободными: там встают грузовики (MINE_ROOM).
	mineRoom = 2,
	-- Сколько тайлов заливает поиск места, куда доедет техника от шахты (BASE_REACH).
	reach = 8000,
	-- Что стоит, кроме шахты и главного здания: по порядку, от главного здания наружу (SANDBOX_BUILDINGS).
	buildings = { "generator", "generator", "generator", "generator", "smelter", "siliconWorks", "blockPlant", "ammoPlant", "metalYard", "siliconStore", "fuelTank", "khariteVault", "blockYard", "ammoBunker", "partsLocker", "spaceport", "factory", "barracks", "matter", "lab", "radar" },
	-- С какими юнитами игрок начинает, кроме грузовиков, и сколько грузовиков (SANDBOX_UNITS, SANDBOX_TRUCKS).
	units = { "builder", "builder", "infantry", "infantry", "rocketeer", "buggy", "tank", "tesla", "carrier" },
	trucks = 4,
}

-- Месторождение, у которого поместится база (findBaseSpot): металл, вокруг шахты проходимо. Левый верхний тайл.
local function baseSpot(ctx): { x: number, y: number }?
	local reach = sandbox.data.searchCells * deposits.CELL
	local spots = {}
	local metal = ctx.protos.deposits.metal
	for _, e in ctx:each({ "Deposit", "Position", "Proto" }) do
		local at = ctx:get(e, "Position")
		if kinds.of(ctx, e) == metal and math.abs(at.x) <= reach and math.abs(at.y) <= reach then
			table.insert(spots, { x = at.x - deposits.SIZE / 2, y = at.y - deposits.SIZE / 2 })
		end
	end
	table.sort(spots, function(a, b)
		return a.x * a.x + a.y * a.y < b.x * b.x + b.y * b.y
	end)
	local mine = ctx.protos.buildings.mine.data
	for _, spot in spots do
		if not scenery.canPlace(ctx, "mine", spot.x, spot.y) then
			continue
		end
		local open = true
		for y = spot.y - 1, spot.y + mine.height do
			for x = spot.x - 1, spot.x + mine.width do
				local inside = x >= spot.x and x < spot.x + mine.width and y >= spot.y and y < spot.y + mine.height
				if not inside and not ctx:walkable(x, y) then
					open = false
				end
			end
		end
		if open then
			return spot
		end
	end
	return nil
end

-- Не подходит ли здание к шахте ближе mineRoom тайлов (clearOfMine).
local function clearOfMine(ctx, spot, name: string, x: number, y: number): boolean
	local kind, mine = ctx.protos.buildings[name].data, ctx.protos.buildings.mine.data
	local room = sandbox.data.mineRoom
	local apart = x >= spot.x + mine.width + room or x + kind.width + room <= spot.x
	return apart or y >= spot.y + mine.height + room or y + kind.height + room <= spot.y
end

-- Стоит ли здание вплотную к тайлу, куда доедет техника (servable).
local function servable(ctx, reach: { [string]: boolean }, name: string, x: number, y: number): boolean
	local kind = ctx.protos.buildings[name].data
	for tileY = y - 1, y + kind.height do
		for tileX = x - 1, x + kind.width do
			local inside = tileX >= x and tileX < x + kind.width and tileY >= y and tileY < y + kind.height
			if not inside and reach[tileX .. ":" .. tileY] then
				return true
			end
		end
	end
	return false
end

-- Ставит здание на ближайшее к (x, y) место с проходом gap, куда подъедет техника (placeNear); nil — места нет.
local function placeNear(ctx, spot, reach, name: string, x: number, y: number, player: number, gap: number): number?
	local tiles = scenery.around(math.round(x), math.round(y), 14)
	for i = 1, #tiles - 1, 2 do
		local tx, ty = tiles[i], tiles[i + 1]
		if scenery.canPlace(ctx, name, tx, ty, gap) and clearOfMine(ctx, spot, name, tx, ty) and servable(ctx, reach, name, tx, ty) then
			return scenery.place(ctx, name, tx, ty, player)
		end
	end
	return nil
end

-- Тестовая карта игрока player (spawnSandbox): где база — туда смотрит камера; nil — подходящего месторождения нет.
function sandbox.spawn(ctx, player: number): { x: number, y: number }?
	local data = sandbox.data
	local spot = baseSpot(ctx)
	if not spot then
		return nil
	end
	scenery.addCredits(ctx, player, data.credits)
	-- Куда доедет техника от шахты: здания и юниты — только там. Считается до того, как встанут здания.
	local flat = ctx:reach_tiles(spot.x - 1, spot.y, data.reach)
	local reach = {}
	for i = 1, #flat - 1, 2 do
		reach[flat[i] .. ":" .. flat[i + 1]] = true
	end
	local mineKind = ctx.protos.buildings.mine.data
	local mine = scenery.place(ctx, "mine", spot.x, spot.y, player)
	local centerX, centerY = spot.x + mineKind.width / 2, spot.y + mineKind.height / 2
	local core = placeNear(ctx, spot, reach, "command", centerX + 4, centerY, player, 2)
	local at = if core then { x = centerX + 6, y = centerY } else { x = centerX, y = centerY }
	local stores = {}
	for _, name in data.buildings do
		local building = placeNear(ctx, spot, reach, name, at.x, at.y, player, 1)
		if building and ctx.protos.buildings[name].data.stores then
			table.insert(stores, building)
		end
	end
	-- База — одна сеть: здания соединены трубами.
	scenery.connectAll(ctx, player)
	-- Запас раскладывается по хранилищам, пока в них есть место.
	for good, amount in data.stock do
		local left = amount
		for _, store in stores do
			local stock = ctx:get(store, "Inventory")
			if stock and left > 0 then
				left -= goods.put(stock, good, left)
				ctx:set(store, "Inventory", { items = stock.items })
			end
		end
	end
	ctx:flush()
	-- Юниты — на свободных тайлах, куда доедет техника.
	local count = data.trucks + #data.units
	local candidates = ctx:free_tiles(math.floor(centerX), math.floor(centerY), count * 4, 2)
	local names, tiles = {}, {}
	for i = 1, #candidates - 1, 2 do
		if #names < count and reach[candidates[i] .. ":" .. candidates[i + 1]] then
			table.insert(names, if #names < data.trucks then "truck" else data.units[#names - data.trucks + 1])
			table.insert(tiles, candidates[i])
			table.insert(tiles, candidates[i + 1])
		end
	end
	local units = require("lib/battle").spawn(ctx, names, player, tiles)
	ctx:flush()
	-- Шахта не в сети базы — руду на переработку возит первый грузовик.
	local index = {}
	for _, network in ctx:networks() do
		for _, member in network.members do
			index[member] = network.members[1]
		end
	end
	if core and units[1] and index[mine] ~= index[core] then
		ctx:emit("haul", { player = player, mine = mine, units = { units[1] } })
	end
	return at
end

return sandbox
