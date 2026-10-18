--!strict
-- Значок «Снять» (paveCanvas в portraits.ts): кнопка инструмента в сетке строителя — плиты с красным крестом.

local paveArt = require("lib/paveArt")

return {
	look = {
		size = 32,
		-- Чертёж — от левого верхнего угла кадра.
		origin = { 0, 0 },
		draw = function(g)
			paveArt.icon(g, "remove")
		end,
	},
}
