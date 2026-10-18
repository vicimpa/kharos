--!strict
-- Значок «Срыть гору» (paveCanvas в portraits.ts): кнопка землеройного инструмента и тема «Землеройные работы».

local paveArt = require("lib/paveArt")

return {
	look = {
		size = 32,
		-- Чертёж — от левого верхнего угла кадра.
		origin = { 0, 0 },
		draw = function(g)
			paveArt.icon(g, "peak")
		end,
	},
}
