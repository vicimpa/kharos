--!strict
-- Багги: машинка быстрая и хрупкая. За водителем сидит пассажир с миниганом — турель gunner — и стреляет во все
-- стороны. Она же разведчик: видит дальше всех на земле. Данные — из packages/base/data/units.json.

local units = require("lib/units")

local buggy = {}

buggy.data = {
	title = "Багги",
	about = "Машинки: быстрые и хрупкие. Багги: за водителем сидит пассажир с миниганом и стреляет во все стороны. Она же разведчик: видит дальше всех на земле.",
	-- Класс брони: по нему оружие бьёт сильнее или слабее.
	kind = "vehicle",
	speed = 6,
	turn = 5,
	radius = 0.45,
	cost = 250,
	-- Секунд на выпуск.
	time = 7,
	hp = 150,
	sight = 11,
	-- Мотор (sounds/motors) и тон машины против него: мелкие выше, громоздкие ниже.
	motor = "petrol",
	pitch = 1.18,
	-- Турели на корпусе: вид из turrets/ и место — вперёд и вправо от центра, в тайлах.
	mounts = { { turret = "gunner", along = -0.16, across = 0 } },
}

-- Из чего сделана сущность: функция от вида, чтобы правки данных другими модами доходили до юнитов.
buggy.entity = function(kind)
	local d = kind.data
	return {
		Position = {},
		Facing = {},
		Owner = {},
		-- Ход — движком (motion): скорость, поворот, радиус корпуса, род (по нему замедление на местности).
		Mover = { speed = d.speed, turn = d.turn, radius = d.radius, class = d.kind },
		Unit = {},
		Sight = { radius = d.sight },
	}
end

-- Облик — чертёж из lib/units (перенос unitArt.ts), звук — мотор.
buggy.look = units.look("buggy", buggy.data.mounts)
buggy.look.icon = { direction = 56 }

return buggy
