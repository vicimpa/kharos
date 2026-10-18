--!strict
-- Завод: выпускает наземные машины за кредиты. Вид папкой: данные и правила здесь, облик — в look.luau.

local factory = {}

factory.data = {
	title = "Завод",
	-- Размер в тайлах; место — центр здания.
	width = 3,
	height = 3,
	-- Что выпускает: виды из units/.
	produces = { "buggy" },
	-- Сколько тайлов от центра видит: половина большей стороны и ещё 4, как у зданий в TS.
	sight = 5.5,
}

factory.entity = function(kind)
	return {
		Position = {},
		Owner = {},
		Producer = {},
		Building = { width = kind.data.width, height = kind.data.height },
		-- Тайлы под зданием заняты: юниты объезжают его (motion).
		Footprint = { width = kind.data.width, height = kind.data.height },
		Sight = { radius = kind.data.sight },
	}
end

factory.look = require("./look")

return factory
