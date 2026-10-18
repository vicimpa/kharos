--!strict
-- Значок «Мосты» (paveCanvas в portraits.ts): тема исследований — дорога по болоту.

local paveArt = require("lib/paveArt")

return {
	look = {
		size = 32,
		-- Чертёж — от левого верхнего угла кадра.
		origin = { 0, 0 },
		draw = function(g)
			paveArt.icon(g, "bridge")
		end,
	},
}
