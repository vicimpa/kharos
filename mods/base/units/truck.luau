--!strict
-- Грузовик возит добытое из шахты в хранилище и заказанное по зонам: см. hauling.ts. Своим лучом он и забирает груз,
-- и сгружает его: зданиям лучи не нужны. Харвестер — шахта на колёсах: копает медленнее шахты, зато сам и где угодно,
-- и сам возит руду на переработку. Тяжелее грузовика: его ловят в поле, и он должен пережить первый налёт.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "units.truck",
	about = "Грузовик возит добытое из шахты в хранилище и заказанное по зонам: см. hauling.ts. Своим лучом он и забирает груз, и сгружает его: зданиям лучи не нужны. Харвестер — шахта на колёсах: копает медленнее шахты, зато сам и где угодно, и сам возит руду на переработку. Тяжелее грузовика: его ловят в поле, и он должен пережить первый налёт.",
	speed = 3.5,
	turn = 4,
	radius = 0.45,
	cost = 150,
	buildTime = 8,
	kind = "vehicle",
	hp = 150,
	sight = 6,
	inventory = 25,
	hauls = true,
	beam = { radius = 2, rate = 10, give = true, take = true },
	supply = 1,
	motor = "diesel",
}

kind.entity = units.entity
kind.look = units.look("truck", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
