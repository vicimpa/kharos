--!strict
-- Радар открывает туман далеко вокруг: так видно, кто идёт к базе, и куда бить артиллерией.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Радар",
	about = "Радар открывает туман далеко вокруг: так видно, кто идёт к базе, и куда бить артиллерией.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Видит округу и разведывает дальние места вспышками; находит месторождения",
	width = 2,
	height = 2,
	cost = 400,
	power = -3,
	sight = 14,
	scan = 60,
	requires = { "generator" },
	research = "radar",
	menu = 35,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
