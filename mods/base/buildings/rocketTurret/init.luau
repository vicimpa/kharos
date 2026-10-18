--!strict
-- Ракетная турель.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Ракетная турель",
	-- Кратко — в карточке кнопки стройки (buildingInfo).
	info = "Ракеты против техники и авиации. Стреляет боеприпасами со своего склада",
	width = 1,
	height = 1,
	cost = 300,
	hp = 400,
	defense = true,
	inventory = 120,
	accepts = { "ammo" },
	ammo = true,
	mounts = { { turret = "rocket", along = 0, across = 0 } },
	requires = { "radar" },
	research = "rockets",
	menu = 39,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
