--!strict
-- Выключенный космопорт не торгует: заявку на продажу не принимает, а включённый — принимает (проверка, что всё
-- остальное для продажи готово). Космопорт и склад металла с запасом ставит хост рядом с главным зданием.

return {
	run = function(s)
		s:start("skirmish", { fog = false })
		s:wait(0.5)
		-- По сети (KHAROS_NET=loopback) s:host — реплика клиента: поставленного там сервер не знает.
		if s:client("online") then
			s:log("по сети пропущен: здания ставит хост")
			return
		end
		local mcv = s:client("mcv")
		s:click(mcv.x, mcv.y)
		s:ui_click("Развернуть")
		local spot = s:client("spot", mcv.entity)
		s:client("look", spot)
		s:wait(0.2)
		local at = s:client("screen", spot)
		s:click(at.x, at.y)
		s:wait_for(function()
			return s:host("count", "command") == 1
		end, 30, "главное здание не появилось")
		local port = s:host("setup", { spot = spot, player = s:client("me") })
		s:check(port ~= nil, "негде поставить космопорт и склад")
		s:wait(0.5)
		-- По сети (loopback) команды доходят не сразу: ждать по условию.
		s:client("port", { "work", { on = false } })
		s:wait_for(function()
			return s:host("off", port)
		end, 3, "космопорт не выключился")
		s:client("port", { "sell", { resource = "metal", amount = 10 } })
		s:wait(1)
		s:check(not s:host("trading", port), "выключенный космопорт принял заявку на продажу")
		s:client("port", { "work", { on = true } })
		s:wait_for(function()
			return not s:host("off", port)
		end, 3, "космопорт не включился")
		s:client("port", { "sell", { resource = "metal", amount = 10 } })
		s:wait_for(function()
			return s:host("trading", port)
		end, 3, "включённый космопорт не принял заявку")
	end,

	client = {
		-- Команда хосту от своего игрока: { имя, аргументы }.
		online = function(c)
			return c.online
		end,
		me = function(c)
			return c.player
		end,
		-- Команда хосту о своём космопорте: { имя, аргументы }; номер космопорта — свой, клиентский (по сети номера
		-- сущностей у клиента и хоста разные).
		port = function(c, command)
			for _, e in c:each({ "Building" }) do
				if c:mine(e) and c:proto(e).name == "spaceport" then
					local args = command[2]
					args.port, args.building = e, e
					c:send(command[1], args)
					return
				end
			end
		end,

		-- Свои сущности с компонентом.
		own = function(c, component: string)
			local list = {}
			for _, e in c:each({ component }) do
				if c:mine(e) then
					table.insert(list, e)
				end
			end
			return list
		end,
		-- Ближайшая к MCV середина места, где он сможет развернуться, — в тайлах мира.
		spot = function(c, unit: number)
			local conversion = require("@base/lib/conversion")
			local data = conversion.building(c).data
			local at = c:get(unit, "Position")
			for ring = 3, 40 do
				for dy = -ring, ring do
					for dx = -ring, ring do
						if math.max(math.abs(dx), math.abs(dy)) == ring then
							local x = math.floor(at.x) + dx - math.floor(data.width / 2)
							local y = math.floor(at.y) + dy - math.floor(data.height / 2)
							if conversion.canDeployAt(c, c.player, unit, x, y) then
								return { x = math.floor(at.x) + dx + 0.5, y = math.floor(at.y) + dy + 0.5 }
							end
						end
					end
				end
			end
			return nil
		end,
		-- Камеру — серединой на точку мира.
		look = function(c, at)
			c.camera.x, c.camera.y = at.x, at.y
		end,
		-- Точка мира на экране.
		screen = function(c, at)
			local x, y = c:to_screen(at.x, at.y)
			return { x = x, y = y }
		end,
		-- Свой MCV и где он на экране.
		mcv = function(c)
			for _, e in c:each({ "Unit" }) do
				local kind = c:proto(e)
				if c:mine(e) and kind and kind.name == "mcv" then
					local at = c:get(e, "Position")
					local x, y = c:to_screen(at.x, at.y)
					return { entity = e, x = x, y = y }
				end
			end
			return nil
		end,
	},

	host = {
		-- Космопорт и склад металла с 50 металла игрока в зоне главного здания; номер космопорта у хоста.
		setup = function(ctx, args)
			local spot, player = args.spot, args.player
			local scenery = require("@base/lib/scenery")
			local function near(name: string): number?
				for ring = 3, 11 do
					for dy = -ring, ring do
						for dx = -ring, ring do
							local x, y = math.floor(spot.x) + dx, math.floor(spot.y) + dy
							if math.max(math.abs(dx), math.abs(dy)) == ring and scenery.canPlace(ctx, name, x, y, 1) then
								return scenery.place(ctx, name, x, y, player)
							end
						end
					end
				end
				return nil
			end
			local yard = near("metalYard")
			local port = near("spaceport")
			if not yard or not port then
				return nil
			end
			ctx:set(yard, "Inventory", { items = { metal = 50 } })
			return port
		end,
		off = function(ctx, port: number)
			return ctx:has(port, "Off")
		end,
		-- Есть ли у космопорта заявка.
		trading = function(ctx, port: number)
			return ctx:has(port, "Trade")
		end,
		-- Сколько зданий этого вида в мире.
		count = function(ctx, name: string)
			local n = 0
			for _, e in ctx:each({ "Building" }) do
				local kind = ctx:proto(ctx:get(e, "Proto").id)
				if kind.name == name and not ctx:has(e, "Site") then
					n += 1
				end
			end
			return n
		end,
	},
}
