--!strict
-- Узел связи подключает здания вокруг без труб: дороже трубы, просит энергию и уязвим — снесли узел, распалась сеть.
-- Оборонительные турели используют то же оружие, что техника, и стреляют боеприпасами со своего склада. На песке все
-- оборонительные постройки слабее.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 1,
	height = 1,
	cost = 250,
	hp = 450,
	defense = true,
	inventory = 120,
	accepts = { "ammo" },
	ammo = true,
	mounts = { { turret = "gunner", along = 0, across = 0 } },
	requires = { "radar" },
	research = "ammo",
	menu = 38,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
