--!strict
-- Правила мира — перенос DEFAULT_RULES из packages/data/src/rules.ts (то, что уже есть в игре): насколько род юнита
-- медленнее на местности — доля скорости, которую отнимает песок, болото и подножие обрыва; солончаки подмораживают
-- болото.

return {
	vehicleSand = 0.1,
	vehicleSwamp = 0.8,
	heavySand = 0,
	heavySwamp = 0.5,
	infantrySand = 0,
	infantrySwamp = 0.5,
	infantryCliff = 0.7,
	frozenSwamp = 0.25,
	toxicSwamp = 0.01,
}
