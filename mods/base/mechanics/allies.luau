--!strict
-- Союзы, переводы и подарки (allies.ts, gift.ts) — команды чата сервера: /ally, /unally, /give. Ответы — ключами словаря
-- host.*; { player = N } в параметрах сервер заменит ником. Союзников не атакуют, разведка у них общая (движок).

local allies = require("lib/allies")
local wallet = require("lib/wallet")

local mechanic = {}

-- Ответ: тому, кто звал (to нет), или игроку to.
local function say(key: string, params: { [string]: any }?, to: number?)
	return { to = to, key = "host." .. key, params = params or {} }
end

local function nick(player: number)
	return { player = player }
end

-- Ответ каждому из списка.
local function tell(out, players: { number }, key: string, params: { [string]: any })
	for _, player in players do
		table.insert(out, say(key, params, player))
	end
end

mechanic.chat = {
	-- Предложить союз главе или одиночке либо принять его предложение.
	ally = {
		args = { "<player>" },
		run = function(ctx, from: number, args)
			local to = args[1]
			if from == 0 then
				return {}
			end
			local book = allies.book(ctx)
			local result = allies.offer(book, from, to)
			allies.commit(ctx, book)
			if result == "refused" then
				return { say(if from == to then "allySelf" else "noPlayer", { name = nick(to) }) }
			elseif result == "fromMember" then
				return { say("allyNotHead") }
			elseif result == "toMember" then
				return { say("allyToMember", { name = nick(to) }) }
			elseif result == "already" then
				return { say("allyAlready", { name = nick(to) }) }
			elseif result == "pending" then
				return { say("allyPending", { name = nick(to) }) }
			end
			local formed = result == "allied"
			return { say(if formed then "allyFormed" else "allyOffered", { name = nick(to) }, from), say(if formed then "allyFormed" else "allyAsked", { name = nick(from) }, to) }
		end,
	},
	-- С именем — исключить союзника (глава), отозвать своё предложение или отклонить чужое; без имени — выйти из союза
	-- (глава распускает его).
	unally = {
		args = { "[player]" },
		run = function(ctx, from: number, args)
			local to = args[1]
			if from == 0 then
				return {}
			end
			local book = allies.book(ctx)
			local out = {}
			if to == from then
				local group = {}
				for _, other in book[from] and book[from].allies or {} do
					table.insert(group, other)
				end
				local result = allies.exit(book, from)
				allies.commit(ctx, book)
				if result == "nothing" then
					return { say("allyNoAlliance") }
				elseif result == "left" then
					table.insert(out, say("allyExited", nil, from))
					tell(out, group, "allyLeftBy", { name = nick(from) })
				else
					table.insert(out, say("allyDissolved", nil, from))
					tell(out, group, "allyDissolvedBy", { name = nick(from) })
				end
				return out
			end
			-- Кого исключение касается: глава и его рядовые — им весть об исключённом, самому исключённому — своя.
			local group = { from }
			for _, other in book[from] and book[from].allies or {} do
				if other ~= to then
					table.insert(group, other)
				end
			end
			local result = allies.breakWith(book, from, to)
			allies.commit(ctx, book)
			if result == "nothing" then
				return { say("allyNothing", { name = nick(to) }) }
			elseif result == "notHead" then
				return { say("allyKickNotHead") }
			elseif result == "kicked" then
				tell(out, group, "allyKicked", { name = nick(to) })
				table.insert(out, say("allyKickedBy", { name = nick(from) }, to))
				return out
			end
			table.insert(out, say(if result == "withdrawn" then "allyWithdrawn" else "allyDeclined", { name = nick(to) }, from))
			if result ~= "withdrawn" then
				table.insert(out, say("allyDeclinedBy", { name = nick(from) }, to))
			end
			return out
		end,
	},
	-- Перевести союзнику кредиты: приходят сразу.
	give = {
		args = { "<player>", "<amount>" },
		run = function(ctx, from: number, args)
			local to, amount = args[1], tonumber(args[2])
			if from == 0 then
				return {}
			end
			if to == from then
				return { say("giveSelf") }
			end
			if not allies.allied(allies.book(ctx), from, to) then
				return { say("giveNoAlly", { name = nick(to) }) }
			end
			if not amount or amount <= 0 or amount ~= math.floor(amount) then
				return { say("usage", { command = "/give <player> <amount>" }) }
			end
			if not wallet.pay(ctx, from, amount) then
				return { say("giveShort", { amount = amount }) }
			end
			wallet.refund(ctx, to, amount)
			return { say("giveSent", { name = nick(to), amount = amount }, from), say("giveGot", { name = nick(from), amount = amount }, to) }
		end,
	},
}

return mechanic
