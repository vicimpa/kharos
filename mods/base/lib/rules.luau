--!strict
-- Правила мира — перенос DEFAULT_RULES из packages/data/src/rules.ts (то, что уже есть в игре): насколько род юнита
-- медленнее на местности — доля скорости, которую отнимает песок, болото и подножие обрыва; солончаки подмораживают
-- болото; покрытие ускоряет; починка и дерево технологий.

return {
	-- Во сколько раз чинить быстрее, чем строить (ноль — ремонта нет), какую долю цены стоит починить с нуля до целого
	-- и сколько секунд после попадания цель не чинится (REPAIR_SPEED, REPAIR_COST, REPAIR_PAUSE).
	repairSpeed = 2,
	repairCost = 0.5,
	repairPause = 3,
	-- Здание строится, когда стоят нужные для него и открыто его исследование (data.requires, data.research).
	techTree = true,
	-- Во сколько раз уровни зданий дороже и дольше, чем в матче (lib/levels).
	upgradeScale = 1,
	vehicleSand = 0.1,
	vehicleSwamp = 0.8,
	heavySand = 0,
	heavySwamp = 0.5,
	infantrySand = 0,
	infantrySwamp = 0.5,
	infantryCliff = 0.7,
	frozenSwamp = 0.25,
	toxicSwamp = 0.01,
	-- Покрытие (lib/paving): слой, где оно лежит, и во сколько раз быстрее голой скалы по фундаменту и по дороге
	-- (FOUNDATION_SPEED, ROAD_SPEED).
	surface = "paving",
	surfaceSpeeds = { 1.2, 1.5 },
}
