--!strict
-- Значок темы «Модернизация» (levelCanvas в portraits.ts): корпус здания и два шеврона над ним.

local levels = require("lib/levels")

return {
	look = {
		size = 32,
		-- Чертёж — от левого верхнего угла кадра.
		origin = { 0, 0 },
		draw = function(g)
			levels.drawIcon(g, 2)
		end,
	},
}
