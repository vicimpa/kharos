--!strict
-- Бомбардировщик: сносит здания и колонны с воздуха, но сам по воздуху не бьёт и хрупок — его встречают ракеты,
-- турели и зенитки. Второй тир.
-- Данные — packages/base/data/units.json, мотор и тон — motors.ts, чертёж — lib/units.

local units = require("lib/units")

local kind = {}

kind.data = {
	title = "Бомбардировщик",
	about = "Бомбардировщик: сносит здания и колонны с воздуха, но сам по воздуху не бьёт и хрупок — его встречают ракеты, турели и зенитки. Второй тир.",
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
kind.look = units.look("bomber", kind.data.mounts)
kind.look.icon = { direction = 56 }

return kind
