--!strict
-- Пушка будущего главного здания едет на крыше: поворачивается, но не стреляет.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "units.mcv",
	about = "Пушка будущего главного здания едет на крыше: поворачивается, но не стреляет.",
	speed = 2.5,
	turn = 2.2,
	radius = 0.8,
	cost = 2000,
	buildTime = 30,
	kind = "heavy",
	hp = 800,
	sight = 9,
	materials = { blocks = 20, metal = 20 },
	mounts = { { turret = "mcv", along = -0.19, across = 0 } },
	supply = 0,
	motor = "heavy",
	pitch = 0.85,
}

-- Очередь главного здания едет в MCV и стоит до разворота (spawnUnit: у MCV — Producer).
function kind.entity(self, protos)
	local entity = units.entity(self, protos)
	entity.Producer = {}
	return entity
end
kind.look = units.look("mcv", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
