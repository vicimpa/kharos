--!strict
-- Разведка радара — перенос radar.ts. Постоянно радар видит недалеко, как обычное здание повыше, а дальше — разведывает
-- вспышками: раз в every секунд открывает круг в size тайлов где-то в своём радиусе (data.scan) на ticks тиков. Вспышка
-- — глаз движка: сущность без вида с Sight, Owner и Position, которая гаснет сама (Flash). После неё место остаётся
-- разведанным, и месторождения на нём игрок знает. Место вспышки радар берёт там, где ещё не разведано, а когда
-- разведано всё — где придётся: так он сначала открывает округу, а потом сторожит её. При нехватке энергии вспышки
-- реже, а если её меньше power от нужного — радар и постоянно видит не дальше обычного здания (Scan.dark); без энергии
-- вовсе и выключенный радар не разведывает. Уровней зданий пока нет: радиус — как у первого.

local buildings = require("lib/buildings")
local economy = require("lib/economy")
local kinds = require("lib/kinds")

local readf64 = buffer.readf64

local mechanic = {}

mechanic.data = {
	-- Раз во сколько секунд вспышка, её радиус в тайлах и сколько тиков она светит (SCAN_EVERY, SCAN_SIZE, SCAN_TICKS).
	every = 10,
	size = 6,
	ticks = 30,
	-- С какой доли нужной энергии радар видит дальше обычного здания (RADAR_POWER).
	power = 0.5,
	-- Раз во сколько тиков радары смотрят, не пора ли: счёт до вспышки идёт этими шагами (CHECK_TICKS).
	check = 10,
	-- Сколько мест радар пробует, ища неразведанное (ATTEMPTS), и соль случайных мест (SALT).
	attempts = 8,
	salt = 40487,
	-- Чаще скольких секунд звук импульса не повторяется (MIN_GAP в worldSounds.ts).
	gap = 15,
}

mechanic.components = {
	-- Радар: тиков до вспышки, видит ли он только как обычное здание, где и когда была последняя вспышка.
	Scan = { wait = 0, dark = false, x = 0, y = 0, tick = -1 },
	-- Глаз вспышки: до какого тика светит.
	Flash = { till = 0 },
}

-- Сколько тайлов видит радар без энергии: как обычное здание (buildingSight с off).
local function darkSight(kind): number
	return math.max(kind.data.width, kind.data.height) / 2 + buildings.BUILDING_SIGHT
end

mechanic.systems = {
	-- Радары ведут счёт до вспышки и вспыхивают (scan).
	scan = {
		query = { "Building", "Owner", "Position" },
		every = mechanic.data.check,
		run = function(q, ctx)
			local data = mechanic.data
			local supply: { [number]: number }? = nil
			local size = ctx.game.data and ctx.game.data.size
			for i = 0, q.n - 1 do
				local at = i * 8
				local entity = readf64(q.entity, at)
				local kind = kinds.of(ctx, entity)
				local radius = kind and kind.data.scan or 0
				if radius == 0 or ctx:has(entity, "Site") then
					continue
				end
				local state = ctx:get(entity, "Scan")
				if not state then
					-- Первая вспышка — через полный срок: радары, поставленные разом, всё равно расходятся — места у
					-- них разные.
					ctx:add(entity, "Scan", { wait = data.every / ctx.dt })
					continue
				end
				-- Энергии не хватает — счёт идёт медленнее, а меньше power — и видит радар как обычное здание.
				supply = supply or economy.supply(ctx)
				local share = (supply :: any)[entity] or 0
				local off = ctx:has(entity, "Off")
				local dark = off or share < data.power
				local sight = if dark then darkSight(kind) else buildings.sight(kind, ctx.protos)
				if ctx:get(entity, "Sight").radius ~= sight then
					ctx:set(entity, "Sight", { radius = sight })
				end
				if off then
					continue
				end
				local wait = state.wait - data.check * share
				if wait > 0 then
					ctx:set(entity, "Scan", { dark = dark, wait = wait })
					continue
				end
				local player = readf64(q.Owner.player, at)
				local x, y = readf64(q.Position.x, at), readf64(q.Position.y, at)
				local spotX, spotY = nil, nil
				for attempt = 0, data.attempts - 1 do
					local turn = ctx.hash(entity, ctx.tick * data.attempts + attempt, data.salt) * math.pi * 2
					-- Корень — чтобы места ложились по кругу ровно, а не кучей у радара.
					local reach = math.sqrt(ctx.hash(entity, ctx.tick * data.attempts + attempt, data.salt + 1)) * radius
					local tx, ty = x + math.cos(turn) * reach, y + math.sin(turn) * reach
					if size and (tx < -size or tx >= size or ty < -size or ty >= size) then
						continue
					end
					spotX, spotY = math.floor(tx * 10 + 0.5) / 10, math.floor(ty * 10 + 0.5) / 10
					if not ctx:explored(player, tx, ty) then
						break
					end
				end
				if not spotX then
					ctx:set(entity, "Scan", { dark = dark, wait = data.every / ctx.dt })
					continue
				end
				ctx:set(entity, "Scan", { dark = dark, wait = data.every / ctx.dt, x = spotX, y = spotY, tick = ctx.tick })
				ctx:spawn(nil, { Position = { x = spotX, y = spotY }, Owner = { player = player }, Sight = { radius = data.size }, Flash = { till = ctx.tick + data.ticks } })
				ctx:signal("radar", { x = x, y = y })
			end
		end,
	},
	-- Вспышки гаснут.
	flashes = {
		query = { "Flash" },
		every = mechanic.data.check,
		run = function(q, ctx)
			for i = 0, q.n - 1 do
				if readf64(q.Flash.till, i * 8) <= ctx.tick then
					ctx:destroy(readf64(q.entity, i * 8))
				end
			end
		end,
	},
}

-- На клиенте: импульс радара — мягкий звон с эхом, не чаще раза в gap секунд (worldSounds.ts).
local last = -math.huge

mechanic.signals = {
	radar = function(c, signal)
		if c.clock - last < mechanic.data.gap then
			return
		end
		last = c.clock
		c:sound("radar", { x = signal.x, y = signal.y, volume = 0.1 })
	end,
}

return mechanic
