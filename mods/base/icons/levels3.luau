--!strict
-- Значок темы «Глубокая модернизация»: корпус здания и три шеврона над ним.

local levels = require("lib/levels")

return {
	look = {
		size = 32,
		-- Чертёж — от левого верхнего угла кадра.
		origin = { 0, 0 },
		draw = function(g)
			levels.drawIcon(g, 3)
		end,
	},
}
