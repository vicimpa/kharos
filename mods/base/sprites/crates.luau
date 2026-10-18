--!strict
-- Груз на земле: кучка деревянных ящиков, от одного до четырёх. Фазы 0–3 — ящики, 4–7 — маска их полос: белая полоса и
-- её тень, подача окрашивает её цветом груза.

local INK = 0x1c1712
local CRATES = 4
-- Ящики кучки: левый верхний угол и сторона в пикселях; первые кладутся первыми.
local SPOTS = { { 4, 7, 7 }, { 9, 3, 6 }, { 1, 2, 5 }, { 10, 10, 5 } }
-- Тень полосы — 0,6 её цвета.
local SHADOW = 0x999999

local function draw(g, _, phase: number)
	local mask = phase >= CRATES
	local count = phase % CRATES + 1
	for i = 1, count do
		local x, y, side = SPOTS[i][1], SPOTS[i][2], SPOTS[i][3]
		local middle = y + math.floor(side / 2)
		if mask then
			g:rect(x + 1, middle - 1, side - 2, 2, 0xffffff)
			g:rect(x + 1, middle + 1, side - 2, 1, SHADOW)
		else
			g:rect(x, y, side, side, INK)
			g:rect(x + 1, y + 1, side - 2, side - 2, 0x7a5a36)
			g:rect(x + 1, y + 1, side - 2, 1, 0x9c7646)
		end
	end
end

return {
	-- Сколько ящиков самое большее и на сколько груза каждый; с какой фазы маски полос.
	data = { crates = CRATES, perCrate = 15, bands = CRATES },
	-- Над покрытием и под зданиями; середина тайла — на месте дропа.
	look = { size = 16, origin = { 0, 0 }, anchor = { 8, 8 }, phases = CRATES * 2, layer = "floor", draw = draw },
}
