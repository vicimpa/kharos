--!strict
-- Бункер боеприпасов.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Бункер боеприпасов",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Хранит боеприпасы зоны; отсюда их возят турелям",
	width = 2,
	height = 1,
	cost = 200,
	inventory = 300,
	accepts = { "ammo" },
	stores = true,
	requires = { "ammoPlant" },
	menu = 21,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
