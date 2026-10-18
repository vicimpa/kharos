--!strict
-- Космопорт торгует: энергию просит всегда. Товар на продажу грузовики сгружают в трюм корабля. Строится из металла,
-- а не из стройблоков: с него начинаются деньги, и первой продаже хватает одной линии металла — без цеха и кремния.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Космопорт",
	about = "Космопорт торгует: энергию просит всегда. Товар на продажу грузовики сгружают в трюм корабля. Строится из металла, а не из стройблоков: с него начинаются деньги, и первой продаже хватает одной линии металла — без цеха и кремния.",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Продаёт ресурсы из хранилищ сети и закупает недостающие за кредиты",
	width = 3,
	height = 3,
	cost = 450,
	power = -5,
	materials = { metal = 20 },
	trades = true,
	inventory = 400,
	accepts = { "metal", "silicon", "fuel", "kharite", "lithium", "uranium", "blocks", "ammo", "parts", "rods" },
	requires = { "generator" },
	research = "trade",
	menu = 28,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
