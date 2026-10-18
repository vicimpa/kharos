--!strict
-- Трубы связывают здания в сеть: по ним идут груз и энергия. Наземная дешёвая и хрупкая и перекрывает проезд, как
-- стена; колодцы ведут подземный отрезок, под которым ездят и строят, а уязвимы только сами колодцы.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.pipe",
	about = "Трубы связывают здания в сеть: по ним идут груз и энергия. Наземная дешёвая и хрупкая и перекрывает проезд, как стена; колодцы ведут подземный отрезок, под которым ездят и строят, а уязвимы только сами колодцы.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.pipe",
	width = 1,
	height = 1,
	cost = 5,
	hp = 60,
	expand = 3,
	sight = 1,
	pipe = "surface",
	research = "pipes",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
