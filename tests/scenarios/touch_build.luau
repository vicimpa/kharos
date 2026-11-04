--!strict
-- Стройка пальцем: призрак стоит в центре, протяжка двигает под ним карту и ничего не закладывает,
-- а кнопка «Поставить» подтверждает место. Строитель — от хоста рядом с главным зданием, место — свободное в зоне.

return {
	run = function(s)
		s:start("skirmish", { fog = false })
		s:wait(0.5)
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
		s:host("builder", spot)
		s:wait(0.2)
		local place = s:client("placing", spot)
		s:check(place ~= nil, "нет места под электростанцию")
		-- Палец двигает карту под центральным призраком; отпускание само по себе ничего не строит.
		local before = s:client("camera")
		s:touch(place.x - 60, place.y - 40, true)
		s:touch(place.x - 30, place.y - 20)
		s:touch(place.x, place.y)
		s:touch(place.x, place.y, false)
		s:wait(0.2)
		local after = s:client("camera")
		s:check(math.abs(after.x - before.x) + math.abs(after.y - before.y) > 0.5, "палец не двигает карту в режиме стройки")
		s:check(s:host("sites", "generator") == 0, "отпущенный палец сам заложил здание")
		-- Центральный призрак подтверждается отдельной кнопкой.
		s:client("look", { x = place.wx, y = place.wy })
		s:wait(0.2)
		local done = s:ui_rect("mode:done")
		s:check(done ~= nil, "на сенсорном экране нет кнопки «Поставить»")
		s:touch(done.x + done.w / 2, done.y + done.h / 2, true)
		s:touch(done.x + done.w / 2, done.y + done.h / 2, false)
		s:wait_for(function()
			return s:host("sites", "generator") == 1
		end, 2, "кнопка «Поставить» не заложила здание")
		local site = s:host("site", "generator")
		s:check(site.x == place.tx and site.y == place.ty, "здание заложено не в центральном призраке")
	end,

	client = {
		-- Выбрать строителя, включить стройку электростанции и найти рядом с главным зданием место, где её можно
		-- заложить: середина на экране и левый верхний тайл.
		placing = function(c, spot)
			local construction = require("@base/lib/construction")
			local kind = c.protos.buildings.generator
			local list = {}
			for _, e in c:each({ "Unit" }) do
				if c:mine(e) and c:proto(e).name == "builder" then
					table.insert(list, e)
				end
			end
			c.shared.selection = list
			c.shared.mode = { kind = "placing", building = "generator" }
			for ring = 3, 10 do
				for dy = -ring, ring do
					for dx = -ring, ring do
						local x, y = math.floor(spot.x) + dx, math.floor(spot.y) + dy
						if math.max(math.abs(dx), math.abs(dy)) == ring and construction.canBuild(c, c.player, kind, x, y) then
							-- Указатель — в тайл (x + w/2, y + h/2): по нему placementOf и найдёт левый верхний (x, y).
							local wx, wy = x + math.floor(kind.data.width / 2) + 0.5, y + math.floor(kind.data.height / 2) + 0.5
							local px, py = c:to_screen(wx, wy)
							return { x = px, y = py, tx = x, ty = y, wx = wx, wy = wy }
						end
					end
				end
			end
			return nil
		end,
		camera = function(c)
			return { x = c.camera.x, y = c.camera.y }
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
		-- Строитель игрока 1 рядом с местом.
		builder = function(ctx, spot)
			ctx:spawn("units/builder", { Position = { x = spot.x + 3, y = spot.y + 3 }, Owner = { player = 1 } })
		end,
		-- Закладки здания этого вида и место первой.
		sites = function(ctx, name: string)
			local n = 0
			for _, e in ctx:each({ "Building", "Site" }) do
				if ctx:proto(ctx:get(e, "Proto").id).name == name then
					n += 1
				end
			end
			return n
		end,
		site = function(ctx, name: string)
			for _, e in ctx:each({ "Building", "Site", "Position" }) do
				if ctx:proto(ctx:get(e, "Proto").id).name == name then
					local b, p = ctx:get(e, "Building"), ctx:get(e, "Position")
					return { x = math.floor(p.x - b.width / 2 + 0.5), y = math.floor(p.y - b.height / 2 + 0.5) }
				end
			end
			return nil
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
