--!strict
-- Значки над зданиями, 16 пикселей: фаза 0 — нехватка энергии, жёлтая молния на красном круге; фаза 1 — «Выключено»,
-- знак питания на сером круге; фаза 2 — «Не подъехать», белая черта на красном круге, как знак «въезд запрещён»; фаза 3
-- — подложка значка нехватки груза: тёмный круг в красном кольце, груз рисуется поверх своим обликом; фаза 4 — «Не
-- хватает кредитов», золотая монета в том же кольце.

local INK = 0x0b111b

local function draw(g, _, phase: number)
	g:circle(8, 8, 8, INK)
	if phase == 0 then
		g:circle(8, 8, 7, 0xc8321f)
		g:circle(7.5, 7.5, 5.5, 0xe5492f)
		for _, stroke in { { 3, INK }, { 1, 0xffe066 } } do
			local width, color = stroke[1], stroke[2]
			g:line(10, 3, 6, 8, width, color)
			g:line(6, 8, 10, 8, width, color)
			g:line(10, 8, 6, 13, width, color)
		end
	elseif phase == 3 or phase == 4 then
		g:circle(8, 8, 7, 0xe5492f)
		g:circle(8, 8, 6, 0x121c2a)
		if phase == 4 then
			g:circle(8, 8, 4, 0x8a5a14)
			g:circle(8, 8, 3.2, 0xf0c95a)
			g:rect(7, 6, 2, 4, 0x8a5a14)
		end
	elseif phase == 2 then
		g:circle(8, 8, 7, 0xc8321f)
		g:circle(7.5, 7.5, 5.5, 0xe5492f)
		g:rect(3, 6, 10, 4, INK)
		g:rect(4, 7, 8, 2, 0xf2f5f8)
	else
		g:circle(8, 8, 7, 0x46505f)
		g:circle(7.5, 7.5, 5.5, 0x5d6878)
		-- Разомкнутое сверху кольцо и черта в разрыве.
		g:ring(8, 8.5, 3.5, 1.4, 0xdfe6ee)
		g:rect(6, 3, 4, 4, 0x5d6878)
		g:rect(7, 3, 2, 6, 0xdfe6ee)
	end
end

return {
	data = { starved = 0, off = 1, blocked = 2, lack = 3, broke = 4 },
	look = { size = 16, origin = { 0, 0 }, phases = 5, draw = draw },
}
