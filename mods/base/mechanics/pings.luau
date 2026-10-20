--!strict
-- Сигнал союзникам (pings.ts): метка в точке карты, которую ping секунд видят сам игрок и его союзники — где бы ни была
-- их камера и что бы ни скрывал туман (Mark со списком viewers, docs/mods.md «По сети»). Гасит её обход меток
-- (mechanics/silos). Не больше limit сигналов от игрока за window секунд: сигналом не засыпают экран союзника.

local allies = require("lib/allies")
local world = require("lib/world")

local mechanic = {}

mechanic.data = {
	seconds = 8,
	limit = 3,
	window = 5,
}

mechanic.commands = {
	-- Сигнал: { x, y } в тайлах.
	ping = function(ctx, player: number, args)
		local d = mechanic.data
		local x, y = tonumber(args.x), tonumber(args.y)
		if not x or not y or x ~= x or y ~= y or not world.inBounds(ctx, math.floor(x), math.floor(y)) then
			return
		end
		local life = math.floor(d.seconds / ctx.dt + 0.5)
		local recent = 0
		for _, e in ctx:each({ "Mark" }) do
			local mark = ctx:get(e, "Mark")
			if mark.kind == "ping" and mark.player == player and (ctx.tick - (mark["until"] - life)) * ctx.dt < d.window then
				recent += 1
			end
		end
		if recent >= d.limit then
			return
		end
		local record = allies.book(ctx)[player]
		ctx:spawn(nil, { Position = { x = x, y = y }, Mark = { kind = "ping", ["until"] = ctx.tick + life, player = player, viewers = record and record.allies or {} } })
	end,
}

return mechanic
