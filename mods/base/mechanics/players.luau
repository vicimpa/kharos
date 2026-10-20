--!strict
-- Игроки и их кредиты. Игрок — сущность без вида с компонентом Player; номер сущности — в ctx.storage.players,
-- кошелёк — lib/wallet.luau, доход — mechanics/economy. Здесь же — начать заново на сервере (respawn) и команды чата
-- администратора о игроках (credits, spawn, killunits, heal, reset, reveal).

local allies = require("lib/allies")
local defeat = require("lib/defeat")
local drops = require("lib/drops")
local wallet = require("lib/wallet")

local players = {}

players.components = {
	-- earned — накопленная дробная часть: стройка платит, разбор возвращает и доход приходит по долям кредита (spend,
	-- earn); rewards — полученные награды по порядку (mechanics/economy); research — открытые темы, plan — очередь
	-- исследований, progress — доля начатых, topic — тема, которую ведут лаборатории (mechanics/research).
	-- camera — где у игрока камера в начале игры: x, y и масштаб (редактор); пусто — у его юнитов.
	-- head, offered, asked — союз (lib/allies): глава, кому предложен и кто предложил; safe — до какого тика игрок под
	-- защитой новичка (mechanics/shelter).
	Player = { id = 0, credits = 0, earned = 0, rewards = {}, research = {}, plan = {}, progress = {}, topic = "", camera = {}, head = -1, offered = {}, asked = {}, safe = 0 },
}

-- До какого тика новичок под защитой (shelter.ts, data.protection партии — минуты): его нельзя атаковать, и сам он не
-- стреляет (бой движка); приказ атаки снимает её раньше (mechanics/combat). Без защиты — 0.
function players.shelter(ctx): number
	local minutes = ctx.game.data and ctx.game.data.protection or 0
	return if minutes > 0 then ctx.tick + math.floor(minutes * 60 / ctx.dt + 0.5) else 0
end

players.on = {
	-- Вошедшему — кошелёк со стартовыми кредитами партии (data.credits). Что ещё у него есть на старте, решает она же.
	player_joined = function(ctx, event)
		local list = ctx.storage.players or {}
		ctx.storage.players = list
		if list[tostring(event.player)] then
			return
		end
		local credits = ctx.game.data and ctx.game.data.credits or 0
		list[tostring(event.player)] = ctx:spawn(nil, { Player = { id = event.player, credits = credits, safe = players.shelter(ctx) } })
	end,
}

-- Больше скольких юнитов /spawn за раз не ставит.
local SPAWN_MOST = 50

-- Своё у игрока: юниты и здания, без турелей — они уходят вместе с носителем.
local function ownedBy(ctx, player: number): ({ number }, { number })
	local units, buildings = {}, {}
	for _, e in ctx:each({ "Owner" }) do
		if ctx:get(e, "Owner").player ~= player or ctx:has(e, "Attached") then
			continue
		end
		if ctx:has(e, "Unit") then
			table.insert(units, e)
		elseif ctx:has(e, "Building") then
			table.insert(buildings, e)
		end
	end
	return units, buildings
end

-- Середина базы игрока: среднее его зданий, а без них — юнитов; ничего нет — nil.
local function baseOf(ctx, player: number): (number?, number?)
	local units, buildings = ownedBy(ctx, player)
	local list = if #buildings > 0 then buildings else units
	if #list == 0 then
		return nil, nil
	end
	local sumX, sumY = 0, 0
	for _, e in list do
		local at = ctx:get(e, "Position")
		sumX += at.x
		sumY += at.y
	end
	return math.floor(sumX / #list), math.floor(sumY / #list)
end

-- Игрок начинает заново (wipePlayer и restart в TS): его остатки исчезают (груз падает на землю), покрытие остаётся,
-- союзы и предложения пропадают, обзор и память о чужом забыты; кредиты — стартовые партии, исследования — его же; новый
-- стартовый набор ставит партия, как при входе (player_joined).
function players.restart(ctx, player: number)
	for _, e in ctx:each({ "Owner" }) do
		if ctx:get(e, "Owner").player == player and not ctx:has(e, "Pave") then
			drops.cargo(ctx, e)
			ctx:destroy(e)
		end
	end
	local entity = wallet.of(ctx, player)
	if entity then
		ctx:set(entity, "Player", { credits = ctx.game.data and ctx.game.data.credits or 0, earned = 0, safe = players.shelter(ctx) })
	end
	local book = allies.book(ctx)
	allies.forget(book, player)
	allies.commit(ctx, book)
	ctx:forget(player)
	ctx:emit("player_joined", { player = player })
end

players.commands = {
	-- Проигравший на сервере начинает заново в новом месте этого мира.
	respawn = function(ctx, player: number, _args)
		if defeat.isDefeated(ctx, player) then
			players.restart(ctx, player)
		end
	end,
}

local function say(key: string, params: { [string]: any }?, to: number?)
	return { to = to, key = "host." .. key, params = params or {} }
end

players.chat = {
	-- Поставить игроку кредиты; +N и -N — прибавить и убавить.
	credits = {
		args = { "<player>", "<amount>" },
		admin = true,
		run = function(ctx, _caller: number, args)
			local who, text = args[1], args[2]
			local amount = tonumber(text)
			if not amount then
				return { say("usage", { command = "/credits <player> <amount>" }) }
			end
			local entity = wallet.of(ctx, who)
			if not entity then
				return { say("noPlayer", { name = { player = who } }) }
			end
			local now = if string.match(text, "^[+-]") then ctx:get(entity, "Player").credits + amount else amount
			ctx:set(entity, "Player", { credits = math.max(0, now) })
			return { say("creditsNow", { name = { player = who }, credits = math.max(0, now) }) }
		end,
	},
	-- Поставить юнитов у базы игрока (себе — без ника).
	spawn = {
		args = { "<unit>", "[count]", "[player]" },
		admin = true,
		run = function(ctx, _caller: number, args)
			local kind, who = args[1], args[3]
			local count = math.clamp(math.floor(tonumber(args[2]) or 1), 1, SPAWN_MOST)
			if type(kind) ~= "string" or not ctx.protos.units[kind] then
				local names = {}
				for name in ctx.protos.units do
					table.insert(names, name)
				end
				table.sort(names)
				return { say("unitTypes", { list = table.concat(names, ", ") }) }
			end
			local x, y = baseOf(ctx, who)
			if not x or not y then
				return { say("noBase", { name = { player = who }, number = who }) }
			end
			local tiles = ctx:free_tiles(x, y, count, 2, ctx.protos.units[kind].data.kind == "air")
			local made = 0
			for i = 1, #tiles - 1, 2 do
				ctx:spawn("units/" .. kind, { Position = { x = tiles[i] + 0.5, y = tiles[i + 1] + 0.5 }, Owner = { player = who } })
				made += 1
			end
			return { { key = "host.spawned", params = { name = { player = who }, unit = kind, count = made } } }
		end,
	},
	-- Убрать все юниты игрока; здания остаются.
	killunits = {
		args = { "[player]" },
		admin = true,
		run = function(ctx, _caller: number, args)
			local units = ownedBy(ctx, args[1])
			for _, e in units do
				ctx:destroy(e)
			end
			return { say("unitsRemoved", { count = #units }) }
		end,
	},
	-- Вся техника и здания игрока целы.
	heal = {
		args = { "[player]" },
		admin = true,
		run = function(ctx, _caller: number, args)
			local units, buildings = ownedBy(ctx, args[1])
			local count = 0
			for _, list in { units, buildings } do
				for _, e in list do
					if ctx:has(e, "Health") then
						ctx:set(e, "Health", { value = 1 })
						count += 1
					end
				end
			end
			return { say("healed", { name = { player = args[1] }, count = count }) }
		end,
	},
	-- Снести всё у игрока и дать ему новый стартовый набор.
	reset = {
		args = { "[player]" },
		admin = true,
		run = function(ctx, _caller: number, args)
			players.restart(ctx, args[1])
			return { say("restarted", { name = { player = args[1] } }, -1) }
		end,
	},
	-- Открыть игроку всю карту.
	reveal = {
		args = { "[player]" },
		admin = true,
		run = function(ctx, _caller: number, args)
			ctx:reveal(args[1])
			return { say("revealed", { name = { player = args[1] } }) }
		end,
	},
}

return players
