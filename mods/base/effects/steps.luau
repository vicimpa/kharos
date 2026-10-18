--!strict
-- Цель текущего первого шага на карте: золотые уголки вокруг места, где сделать шаг (lib/steps). Дышат, чтобы цель
-- находилась глазом, но не мешали смотреть, что под ней. Список шагов скрыт — обводки нет.

local stepsLib = require("lib/steps")
local settings = require("lib/settings")

-- Цвет уголков, длина уголка и отступ от цели в тайлах, толщина — три линии рамки, но не тоньше 3 пикселей.
local COLOR = 0xffd14d
local CORNER = 0.9
local MARGIN = 0.3
local BORDER = 1 / 16

local function update(c)
	if settings.prefs(c).steps == "off" then
		return
	end
	local target = stepsLib.of(c).target
	if not target then
		return
	end
	local alpha = 0.75 + 0.25 * math.sin(c.time * 4)
	local thick = math.max(BORDER * 3, 3 / c.camera.zoom)
	local left, top = target.x - MARGIN, target.y - MARGIN
	local right, bottom = target.x + target.width + MARGIN, target.y + target.height + MARGIN
	for _, corner in { { left, top, 1, 1 }, { right, top, -1, 1 }, { left, bottom, 1, -1 }, { right, bottom, -1, -1 } } do
		local x, y, dx, dy = corner[1], corner[2], corner[3], corner[4]
		c.draw:rect(x, y, x + dx * CORNER, y + dy * thick, COLOR, nil, alpha)
		c.draw:rect(x, y, x + dx * thick, y + dy * CORNER, COLOR, nil, alpha)
	end
end

return { update = update }
