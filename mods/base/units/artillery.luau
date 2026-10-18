--!strict
-- Артиллерия: гаубица на колёсном лафете. Бьёт дальше турелей, но видит меньше, чем стреляет, — ей нужен разведчик;
-- хрупкая и с мёртвой зоной вблизи, без прикрытия её съедают машинки. Второй тир. Мотор и тон — sounds/motors.

local units = require("lib/units")

local INK, STEEL, IRON = units.INK, units.STEEL, units.IRON

-- Артиллерия: гаубица на колёсном лафете. Две пары колёс, станины с сошниками назад, щит расчёта и длинный ствол с
-- дульным тормозом вперёд — ствол длиннее корпуса, видно издалека.
local function draw(p, team, phase)
	-- Станины расходятся назад, на концах — сошники.
	p.line(-1, -3, -12, -6, 2.4, INK)
	p.line(-1, 3, -12, 6, 2.4, INK)
	p.line(-1, -3, -11.5, -5.8, 1, IRON[2])
	p.line(-1, 3, -11.5, 5.8, 1, IRON[2])
	p.beam(-12, -7.5, -4.5, 1.6, IRON[3])
	p.beam(-12, 4.5, 7.5, 1.6, IRON[3])
	for _, along in { -3, 3 } do
		for _, across in { -6, 6 } do
			units.tire(p, along, across, 2.2, 3, phase)
		end
	end
	-- Лафет.
	p.bar(-6, 5, 0, 9, INK)
	p.bar(-5, 4, 0, 7, STEEL[1])
	p.bar(-5, 4, -2.8, 1, STEEL[3])
	p.bar(-5, -3, 0, 7, team[0])
	-- Щит расчёта.
	p.beam(2.5, -5, 5, 2, INK)
	p.beam(2.5, -4.5, 4.5, 1, STEEL[3])
	-- Ствол с дульным тормозом.
	p.bar(-2, 14, 0, 3.4, INK)
	p.bar(-1, 13, 0, 1.8, IRON[3])
	p.bar(-1, 13, -0.6, 0.6, IRON[4])
	p.bar(12.5, 15, 0, 4.2, INK)
	p.bar(13, 14.5, 0, 2.6, IRON[2])
	p.dot(-1.5, 0, 2.6, INK)
	p.dot(-1.5, 0, 1.8, team[1])
end

local kind = {}

kind.data = {
	speed = 2.4,
	turn = 2.2,
	radius = 0.6,
	cost = 800,
	buildTime = 16,
	kind = "vehicle",
	hp = 200,
	weapon = "artillery",
	sight = 8,
	ammo = 80,
	materials = { metal = 16, blocks = 4, parts = 2 },
	research = "siege",
	supply = 3,
	motor = "diesel",
}

kind.entity = units.entity
kind.look = units.look({
	gait = "wheels",
	draw = draw,
	mounts = kind.data.mounts,
	traces = { sides = { -6, 6 }, width = 3 },
	lights = {
		lamps = { { 6, -3, 2 }, { 6, 3, 2 } },
		beam = { along = 9, length = 52, near = 4, spread = 0.3, level = 1 },
	},
})

return kind
