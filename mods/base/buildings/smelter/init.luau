--!strict
-- Переработка — по зданию на руду: каждое принимает только свою руду и выдаёт её ресурс, один передел (§4.3 шаг 5).
-- Приём 1,5 руды/с — примерно полторы шахты металла: где поставить завод между шахтами и хранилищем, решает игрок.
-- Руду держит про запас на кузов, готовое отдаёт по общим заявкам. Переработку открывает электростанция, а не шахта:
-- так решили, когда руду возили и харвестеры (2026-10-07).

local buildings = require("lib/buildings")

local kind = {}

kind.data = {
	width = 3,
	height = 3,
	cost = 300,
	power = -3,
	inventory = 60,
	refines = "metalOre",
	accepts = { "metalOre", "metal" },
	limits = { metalOre = 30, metal = 30 },
	requires = { "generator" },
	research = "metalOre",
	menu = 4,
	-- Раздел сетки строителя.
	section = "industry",
}

kind.entity = buildings.entity
kind.look = require("./look")

return kind
