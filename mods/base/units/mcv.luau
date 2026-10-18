--!strict
-- Пушка будущего главного здания едет на крыше: поворачивается, но не стреляет. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON = units.INK, units.STEEL, units.IRON

-- MCV: широкая гусеничная машина с кабиной спереди и пушкой будущего ядра на крыше.
local function draw(p, team, phase)
	for _, side in { -8, 8 } do
		p.bar(-13, 13, side, 7, INK)
		p.bar(-12, 12, side, 5, IRON[1])
		units.treads(p, -12, 12, side, 2.5, phase, IRON[0])
	end
	p.bar(-11, 12, 0, 14, INK)
	p.bar(-10, 11, 0, 12, STEEL[1])
	p.bar(-10, 11, -5, 2, STEEL[2])
	p.bar(6, 11, 0, 10, STEEL[3])
	p.bar(8, 10, 0, 6, team[2])
	-- Пушка будущего ядра едет на крыше — отдельной турелью mcv.
end

local kind = {}

kind.data = {
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
kind.look = units.look({
	gait = "tracks",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -8, 8 }, width = 5 },
	lights = {
		lamps = { { 12, -4, 3 }, { 12, 4, 3 } },
		beam = { along = 14, length = 72, near = 7, spread = 0.3, level = 1 },
	},
})

return kind
