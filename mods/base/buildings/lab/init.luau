--!strict
-- Лаборатория ведёт исследования: они открывают переработку, цеха, армию и уровни зданий. Нужна с самого начала — до
-- плавильни, — поэтому дешёвая и без материалов; несколько лабораторий исследуют одну тему вместе, быстрее. Склад — под
-- сырьё нынешней темы: его подвозят грузовики и трубы (lib/logistics).

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 2,
	height = 2,
	cost = 300,
	power = -3,
	researches = true,
	inventory = 40,
	requires = { "generator" },
	menu = 32,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
