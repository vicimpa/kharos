--!strict
-- Пехота. Огнемётчик: штурмовик ближнего боя — выжигает пехоту в окопах и здания, к броне ему не подойти.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "Огнемётчик",
	about = "Пехота. Огнемётчик: штурмовик ближнего боя — выжигает пехоту в окопах и здания, к броне ему не подойти.",
	speed = 3.4,
	turn = 10,
	radius = 0.3,
	cost = 140,
	buildTime = 5,
	kind = "infantry",
	hp = 90,
	weapon = "flame",
	research = "flamer",
	ammo = 20,
	supply = 1,
}

kind.entity = units.entity
kind.look = units.look("flamer", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
