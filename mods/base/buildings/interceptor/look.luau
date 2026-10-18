--!strict
-- Перехватчик, 2×2: бетонная плита, на поворотном станке — пакет из четырёх пусковых труб, нацеленный в небо; слева —
-- будка с плоской антенной наведения. Вариант — сколько ракет готово: в торцах заряженных труб виден красный нос,
-- пустые темны. working — есть хоть одна: лампа зелёная, у пустого — жёлтая и мигает.

local b = require("lib/buildings")

local STEEL, IRON, INK, DARK, HAZARD, FIRE = b.STEEL, b.IRON, b.INK, b.DARK, b.HAZARD, b.FIRE
local round, pulse, chase = b.round, b.pulse, b.chase
local CONCRETE = { [0] = 0x4f4c47, 0x77736b, 0x9d988e, 0xbfb9ae, 0xe0dbd1 }
-- Сколько ракет держит перехватчик (intercept.capacity в buildings.json).
local CAPACITY = 4

return b.look(2, 2, function(g, t: number, working: boolean, variant: number)
	b.slab(g, 0, 2, 32, 30, 3, CONCRETE)
	for x = 2, 29, 4 do
		g:rect(x, 27, 2, 1, HAZARD[1])
		g:rect(x + 2, 27, 2, 1, HAZARD[0])
	end
	-- Будка наведения и антенна над ней: плоская решётка под наклоном, по ней бежит огонёк.
	b.slab(g, 2, 13, 10, 12, 3, IRON)
	b.windows(g, { 4 }, 17)
	g:rect(3, 5, 9, 8, INK)
	g:rect(4, 6, 7, 6, STEEL[1])
	for x = 5, 10, 2 do
		for y = 7, 11, 2 do
			g:rect(x, y, 1, 1, STEEL[3])
		end
	end
	b.bulb(g, 4 + round(chase(t, 0) * 5), 6, chase(t, 0))
	-- Станок и пакет труб: смотрит вверх и вправо.
	b.tower(g, 21, 21, 5, 2, IRON)
	local fromX, fromY, toX, toY = 18, 22, 25, 9
	g:line(fromX, fromY, toX, toY, 11, INK)
	g:line(fromX, fromY, toX, toY, 9, STEEL[1])
	g:line(fromX - 2.5, fromY, toX - 2.5, toY, 2, STEEL[3])
	g:line(fromX + 3, fromY + 0.5, toX + 3, toY + 0.5, 1.5, STEEL[0])
	-- Торцы труб — квадратом два на два; заряженные — с носом ракеты, первыми тратятся верхние.
	g:rect(toX - 5, toY - 5, 10, 10, INK)
	g:rect(toX - 4, toY - 4, 8, 8, STEEL[2])
	g:rect(toX - 4, toY - 4, 8, 1, STEEL[3])
	local ports = { { toX - 2, toY - 2 }, { toX + 2, toY - 2 }, { toX - 2, toY + 2 }, { toX + 2, toY + 2 } }
	for index, port in ports do
		local x, y = port[1], port[2]
		local loaded = index - 1 >= #ports - variant
		g:circle(x, y, 1.9, if loaded then IRON[3] else DARK)
		if loaded then
			g:circle(x, y, 1.2, FIRE[1])
			g:rect(math.floor(x) - 1, math.floor(y) - 1, 1, 1, FIRE[3])
		end
	end
	local ready = if working then 0x5fe08a else 0xe0b84a
	g:rect(14, 22, 3, 3, INK)
	g:rect(15, 23, 1, 1, ready)
	g:light(15.5, 23.5, 1.5, if working then 0.6 else 0.2 + 0.3 * pulse(t * 2))
end, { working = true, variants = CAPACITY + 1 })
