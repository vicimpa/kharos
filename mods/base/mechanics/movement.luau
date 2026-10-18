--!strict
-- Ход юнитов — системы движка (motion), перенос movement.ts: пути упёршимся (planPaths), потом движение по путям с
-- объездом и расталкиванием (moveUnits). Место в тике — как в sim.ts: после производства, перед носителями.
-- Замедление по местности — правила партии (data.rules, lib/rules).

return {
	systems = {
		plan = { engine = "plan_paths", after = { "produce" } },
		move = { engine = "move_units", after = { "plan" } },
	},
}
