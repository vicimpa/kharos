--!strict
-- Молния перегруза (drawBolt в powerPass.ts): ломаная от края к краю картинки с короткой веткой, светлая сердцевина в
-- синем ореоле. Шесть разных — фазы; эффект энергии (effects/power) растягивает молнию на всё здание.

local noise = require("lib/noise").of

local SIZE = 32
local JOINTS = 6
local GLOW, CORE = 0x4f9dff, 0xf2fbff

local function draw(g, _, index: number)
	local points = {}
	-- Молнии идут то сверху вниз, то наискось: начало и конец на разных краях.
	local x = 4 + noise(index, 1) * (SIZE - 8)
	local endX = 4 + noise(index, 2) * (SIZE - 8)
	for i = 0, JOINTS do
		local along = i / JOINTS
		x += (endX - x) * along * 0.5 + (noise(index, 10 + i) - 0.5) * 12
		x = math.max(2, math.min(SIZE - 3, x))
		table.insert(points, math.floor(x + 0.5))
		table.insert(points, math.floor(2 + along * (SIZE - 5) + 0.5))
	end
	-- Ветка от середины в сторону.
	local from = 2 * (1 + math.floor(noise(index, 3) * (JOINTS - 2))) + 1
	local side = if noise(index, 4) < 0.5 then -1 else 1
	local branch = {
		points[from], points[from + 1],
		points[from] + side * 5, points[from + 1] + 3,
		points[from] + side * 7, points[from + 1] + 8,
	}
	for _, stroke in { { points, 3, GLOW }, { branch, 2, GLOW }, { points, 1, CORE }, { branch, 1, CORE } } do
		local line, width, color = stroke[1], stroke[2], stroke[3]
		for i = 1, #line - 3, 2 do
			g:line(line[i], line[i + 1], line[i + 2], line[i + 3], width, color)
		end
	end
end

return {
	data = { variants = 6 },
	look = { size = SIZE, origin = { 0, 0 }, phases = 6, draw = draw },
}
