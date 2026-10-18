--!strict
-- Превращения на экране: сворачивающееся главное здание уходит сверху вниз, как стройка наоборот; на месте
-- разворачивающегося MCV главное здание растёт снизу вверх, а сам MCV тает; куда едут разворачиваться свои MCV, видно
-- призраком здания, пока они в пути.

local conversion = require("lib/conversion")
local placement = require("lib/placement")

-- Призрак намеченного места, с предумноженной альфой.
local PLANNED = { 0.4, 0.4, 0.4, 0.4 }

-- Какая доля превращения ещё впереди, плавно между тиками.
local function remaining(c, converting): number
	return math.clamp((converting.left - c.alpha) / converting.total, 0, 1)
end

local function update(c)
	local building = conversion.building(c)
	local width, height = building.data.width, building.data.height
	for _, e in c:each({ "Converting", "Position" }) do
		local left = remaining(c, c:get(e, "Converting"))
		if c:has(e, "Unit") then
			local at = c:get(e, "Position")
			if c:mine(e) or c:sees(at.x, at.y) then
				local x, y = conversion.site(c, e)
				c:show(building, placement.middle(x, width), placement.middle(y, height), { built = 1 - left, player = c:get(e, "Owner").player })
			end
			c:dress(e, { fade = left })
		else
			c:dress(e, { built = left })
		end
	end
	for _, e in c:each({ "Deploys", "Owner" }) do
		if c:mine(e) and not c:has(e, "Converting") then
			local deploys = c:get(e, "Deploys")
			c:show(building, placement.middle(deploys.x, width), placement.middle(deploys.y, height), { tint = PLANNED, over = true })
		end
	end
end

return { update = update }
