--!strict
-- Игроки и их кредиты. Игрок — сущность без вида с компонентом Player; номер сущности — в ctx.storage.players,
-- кошелёк — lib/wallet.luau.

local players = {}

players.data = {
	-- Доход каждого игрока, кредитов в секунду.
	income = 5,
}

players.components = {
	-- earned — накопленная дробная часть: стройка платит и разбор возвращает по долям кредита (spend, earn).
	Player = { id = 0, credits = 0, earned = 0 },
}

players.on = {
	-- Вошедшему — кошелёк со стартовыми кредитами партии (data.credits). Что ещё у него есть на старте, решает она же.
	player_joined = function(ctx, event)
		local list = ctx.storage.players or {}
		ctx.storage.players = list
		if list[tostring(event.player)] then
			return
		end
		local credits = ctx.game.data and ctx.game.data.credits or 0
		list[tostring(event.player)] = ctx:spawn(nil, { Player = { id = event.player, credits = credits } })
	end,
}

players.systems = {
	-- Раз в секунду — доход.
	income = {
		query = { "Player" },
		write = { "Player" },
		every = 20,
		run = function(q, ctx)
			local credits = q.Player.credits
			local gain = players.data.income * ctx.dt * 20
			for i = 0, q.n - 1 do
				buffer.writef64(credits, i * 8, buffer.readf64(credits, i * 8) + gain)
			end
		end,
	},
}

return players
