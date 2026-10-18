--!strict
-- Работа над покрытием на тайле (paving.at в paved.ts): номер сущности с Pave — укладки или разбора; 0 — работы нет.
-- Так стройке и протяжке не нужно перебирать все работы, чтобы найти ту, что на тайле (lib/surface).

return {
	data = { scope = "world", shape = "grid", channels = { "u32" }, save = true },
}
