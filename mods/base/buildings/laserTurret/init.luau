--!strict
-- Лазерная турель — противотанковая: бьёт мгновенно и лучше всего по тяжёлой броне. Патронов не просит, а питается от
-- энергии зоны: грузовики ей не нужны, но электростанция — нужна.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "buildings.laserTurret",
	about = "Лазерная турель — противотанковая: бьёт мгновенно и лучше всего по тяжёлой броне. Патронов не просит, а питается от энергии зоны: грузовики ей не нужны, но электростанция — нужна.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "buildingInfo.laserTurret",
	width = 1,
	height = 1,
	cost = 400,
	hp = 450,
	defense = true,
	power = -2,
	mounts = { { turret = "laser", along = 0, across = 0 } },
	requires = { "radar" },
	research = "lasers",
	menu = 41,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
