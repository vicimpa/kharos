--!strict
-- Стройка пальцем: в режиме выбора места касание показывает призрак, палец его ведёт, а отпущенный палец закладывает
-- здание там, где его отпустили; пока палец на экране, ничего не заложено. Строитель — от хоста рядом с главным
-- зданием, место — свободное в зоне.

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
		-- Коснуться в стороне, провести к месту, держать — ничего не заложено.
		s:touch(place.x - 60, place.y - 40, true)
		s:touch(place.x - 30, place.y - 20)
		s:touch(place.x, place.y)
		s:wait(0.3)
		s:check(s:host("sites", "generator") == 0, "здание заложено, пока палец на экране")
		s:touch(place.x, place.y, false)
		s:wait_for(function()
			return s:host("sites", "generator") == 1
		end, 2, "отпущенный палец не заложил здание")
		local site = s:host("site", "generator")
		s:check(site.x == place.tx and site.y == place.ty, "здание заложено не там, где отпустили палец")
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
							local px, py = c:to_screen(x + math.floor(kind.data.width / 2) + 0.5, y + math.floor(kind.data.height / 2) + 0.5)
							return { x = px, y = py, tx = x, ty = y }
						end
					end
				end
			end
			return nil
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
