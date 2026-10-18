--!strict
-- Главное меню — тоже партия: мир под окнами меню (у TS там слайды симуляции, gui/screens/showcase.ts) и панель
-- ui/menu. Игроков и правил у неё нет.

return {
	data = {
		title = "Главное меню",
		land = "desert",
		size = 64,
		fog = false,
	},
	client = {
		ui = { "menu" },
		atmosphere = { "weather" },
		audio = { "interface" },
	},
}
