--!strict
-- Первые шаги игрока через панель: выбрать MCV щелчком по карте, нажать «Развернуть», указать место — MCV доезжает и
-- становится главным зданием; потом открыть и закрыть окно исследований.

return {
	run = function(s)
		s:start("skirmish", { fog = false })
		s:wait(0.5)
		s:check(#s:client("own", "Unit") == 6, "стартовый набор — не шесть юнитов")
		local mcv = s:client("mcv")
		s:click(mcv.x, mcv.y)
		s:check(s:ui_has("MCV"), "MCV не выбран")
		s:ui_click("Развернуть")
		-- Место — ближайшее, где MCV сможет развернуться (на скале, по тем же правилам, что призрак под указателем):
		-- камеру — туда, щелчок — по нему на экране.
		local spot = s:client("spot", mcv.entity)
		s:check(spot ~= nil, "негде развернуться")
		s:client("look", spot)
		s:wait(0.2)
		local at = s:client("screen", spot)
		s:pointer(at.x, at.y)
		s:click(at.x, at.y)
		s:wait_for(function()
			return s:host("count", "command") == 1
		end, 30, "главное здание не появилось")
		s:ui_click("Исследования")
		s:check(s:ui_has("Научный метод"), "окно исследований не открылось")
		s:key("escape")
		s:check(not s:ui_has("Научный метод"), "окно исследований не закрылось")
	end,

	client = {
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
