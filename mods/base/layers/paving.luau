--!strict
-- Готовое покрытие карты (Paving в paved.ts): канал 0 — вид (1 фундамент, 2 дорога), канал 1 — хозяин. Ход движка
-- читает вид по data.rules.surface; правила — lib/paving.

return {
	data = { scope = "world", shape = "grid", channels = { "u8", "u8" }, save = true },
}
