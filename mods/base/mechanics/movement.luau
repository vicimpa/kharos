--!strict
-- Ход юнитов — системы движка (motion): пути упёршимся, потом движение по путям с объездом и расталкиванием. Место в
-- тике: после производства, перед носителями. Замедление по местности — правила партии (data.rules, lib/rules).

return {
	systems = {
		plan = { engine = "plan_paths", after = { "produce" } },
		move = { engine = "move_units", after = { "plan" } },
	},
}
