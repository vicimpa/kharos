--!strict
-- Тестовая карта (?sandbox в launch.ts, spawnSandbox в local.ts): та же схватка, но вошедший получает готовую базу у
-- ближайшего металла (lib/sandbox) и камеру над ней; не нашлось места — стартовый набор, как в обычной игре.

local skirmish = require("games/skirmish")
local sandbox = require("lib/sandbox")

local game = table.clone(skirmish)
game.data = table.clone(skirmish.data)
game.data.title = "games.sandbox"

game.on = {
	player_joined = function(ctx, event)
		local at = sandbox.spawn(ctx, event.player)
		if not at then
			skirmish.on.player_joined(ctx, event)
			return
		end
		for _, e in ctx:each({ "Player" }) do
			if ctx:get(e, "Player").id == event.player then
				ctx:set(e, "Player", { camera = { at.x, at.y, 32 } })
			end
		end
	end,
}

return game
