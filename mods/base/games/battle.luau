--!strict
-- Показательный бой: у начала мира — своя случайная армия против армии учебного противника той же цены; юниты стреляют
-- бесплатно (в бою армий сетей нет). Свободных бой ведёт сам (lib/battle.drive): каждому — ближайший враг.

local skirmish = require("games/skirmish")
local battle = require("lib/battle")

local game = table.clone(skirmish)
game.data = table.clone(skirmish.data)
game.data.rules = table.clone(skirmish.data.rules)
game.data.rules.unitAmmo = false

game.on = {
	player_joined = function(ctx, event)
		battle.spawnBattle(ctx, event.player, 0, 0, battle.randomArmy(ctx), battle.randomArmy(ctx))
	end,
}

game.systems = {
	-- В бою армий у игрока нет ни кошелька, ни баз: без записи игрока нет и поражения «не осталось ни зданий, ни MCV».
	-- Запись заводит mechanics/players при входе — она уходит в первом тике.
	unlisted = {
		run = function(_, ctx)
			if ctx.storage.unlisted then
				return
			end
			ctx.storage.unlisted = true
			for _, e in ctx:each({ "Player" }) do
				ctx:destroy(e)
			end
			ctx.storage.players = {}
		end,
	},
	drive = {
		every = 10,
		run = function(_, ctx)
			battle.drive(ctx, 1)
		end,
	},
}

return game
