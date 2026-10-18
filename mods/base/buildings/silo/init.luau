--!strict
-- Ракетная шахта: ядерный удар в любую точку карты (§9 п. 4 design.md). Боеголовка — 20 стержней: удар стоит урана на
-- двадцать минут реактора. Ракета чуть быстрее дрона: от пуска до удара через всю карту около двух минут. Разрушенная
-- с боеголовкой рвётся, как реактор, — без ядерного взрыва.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 3,
	height = 3,
	cost = 3000,
	power = -10,
	materials = { blocks = 20, parts = 10 },
	meltdown = { radius = 4, damage = 600 },
	warhead = {
		cost = 2000,
		materials = { rods = 20, parts = 10 },
		seconds = 180,
		launch = 30,
		speed = 8,
		blast = { radius = 12, core = 6, damage = 3000 },
	},
	requires = { "rodPlant" },
	research = "warheads",
	menu = 27,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
