--!strict
-- Разрядная турель — против толпы: разряд бьёт цель и перескакивает на соседей, достаёт и до летающих, но недалеко.
-- Как и лазерная, патронов не просит и стреляет энергией зоны, только берёт её больше.
-- Данные — packages/base/data/buildings.json, облик — look.luau.

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	title = "Разрядная турель",
	about = "Разрядная турель — против толпы: разряд бьёт цель и перескакивает на соседей, достаёт и до летающих, но недалеко. Как и лазерная, патронов не просит и стреляет энергией зоны, только берёт её больше.",
	width = 1,
	height = 1,
	cost = 500,
	hp = 450,
	defense = true,
	power = -3,
	mounts = { { turret = "arc", along = 0, across = 0 } },
	requires = { "radar" },
	research = "arcs",
	menu = 42,
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
