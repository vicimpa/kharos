--!strict
-- Месторождения на карте: при старте партии генератор раскладывает их по клеткам (lib/deposits), каждое — сущность
-- своего вида из deposits/ с запасом. Добыча — дело шахт, когда они появятся.

local deposits = require("lib/deposits")

return {
	components = {
		-- Запас, что остался, и сколько было.
		Deposit = { reserve = 0, total = 0 },
	},
	on = {
		start = function(ctx)
			local data = ctx.game.data or {}
			local size = data.size
			local land = data.land and ctx.protos.lands[data.land]
			if not size or not land then
				return
			end
			-- Генератор — как у местности (land_config хоста): вид местности, поверх data.generator и сид партии.
			local config = table.clone(land.data)
			for key, value in data.generator or {} do
				config[key] = value
			end
			config.seed = data.seed or config.seed
			local bounds = { left = -size, top = -size, right = size, bottom = size }
			local kinds = ctx.protos.deposits
			local from, to = math.floor(-size / deposits.CELL), math.floor((size - 1) / deposits.CELL)
			for cellY = from, to do
				for cellX = from, to do
					local spot = deposits.generate(ctx, kinds, config, bounds, cellX, cellY)
					if spot then
						ctx:spawn("deposits/" .. spot.kind, {
							Position = { x = spot.x + deposits.SIZE / 2, y = spot.y + deposits.SIZE / 2 },
							Deposit = { reserve = spot.reserve, total = spot.reserve },
						})
					end
				end
			end
		end,
	},
}
