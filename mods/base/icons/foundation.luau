--!strict
-- Значок «Фундамент» (paveCanvas в portraits.ts): тема исследований и кнопка инструмента в сетке строителя.

local paveArt = require("lib/paveArt")

return {
	look = {
		size = 32,
		-- Чертёж — от левого верхнего угла кадра.
		origin = { 0, 0 },
		draw = function(g)
			paveArt.icon(g, "foundation")
		end,
	},
}
