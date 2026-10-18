--!strict
-- Бомбардировщик: сносит здания и колонны с воздуха, но сам по воздуху не бьёт и хрупок — его встречают ракеты, турели
-- и зенитки. Второй тир. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON, HAZARD = units.INK, units.STEEL, units.IRON, units.HAZARD

-- Бомбардировщик: широкое крыло-стрела с двумя моторами, бомбовый отсек на брюхе и двойной хвост.
local function draw(p, team)
	-- Крыло-стрела: от носа назад к законцовкам.
	for _, side in { -1, 1 } do
		p.line(4, 0, -6, side * 13, 5, INK)
		p.line(4, 0, -6, side * 12.5, 3, STEEL[1])
		p.line(3, side * 1, -5, side * 11.5, 1, STEEL[3])
		p.dot(-6, side * 12, 1.4, team[0])
		-- Мотор на крыле.
		p.bar(-3, 4, side * 6, 3.4, INK)
		p.bar(-2, 3, side * 6, 1.8, IRON[3])
		p.dot(4, side * 6, 1, HAZARD[2])
	end
	-- Двойной хвост.
	for _, side in { -3, 3 } do
		p.bar(-12, -7, side, 2.4, INK)
		p.bar(-11, -7, side, 1, STEEL[2])
	end
	-- Фюзеляж и бомбовый отсек.
	p.bar(-11, 11, 0, 6, INK)
	p.bar(-10, 10, 0, 4, STEEL[2])
	p.bar(-10, 10, -1.5, 1, STEEL[3])
	p.bar(-5, 3, 0, 3, INK)
	p.bar(-4, 2, 0, 1.6, HAZARD[1])
	p.bar(-10, -7, 0, 4, team[0])
	p.bar(6, 10, 0, 2.6, team[2])
end

local kind = {}

kind.data = {
	speed = 5.5,
	turn = 2.5,
	radius = 0.7,
	cost = 700,
	buildTime = 14,
	kind = "air",
	hp = 180,
	weapon = "bomb",
	sight = 7,
	ammo = 70,
	materials = { metal = 10, fuel = 12, parts = 2 },
	research = "bombing",
	supply = 3,
	motor = "jet",
}

kind.entity = units.entity
kind.look = units.look({
	gait = "air",
	draw = draw,
	mounts = kind.data.mounts,
	lights = {
		lamps = { { 9, -6, 2 }, { 9, 6, 2 } },
		beam = { along = 13, length = 56, near = 4, spread = 0.32, level = 0.9 },
	},
})

return kind
