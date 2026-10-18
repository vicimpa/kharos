--!strict
-- Мод base — сама игра Kharos: юниты, здания, механики и подача. Движок без него — пустое поле.

-- Разделы с названиями видов в словаре и ключ описания вида по разделу («buildingInfo.factory»; false — без описания).
local TITLED = { units = false, buildings = "buildingInfo", research = "researchInfo", goods = false, games = false }

return {
	name = "base",
	version = "0.1.0",
	title = "Kharos",
	-- Партия по умолчанию — вид из games/.
	game = "skirmish",
	-- Главное меню — тоже партия из games/: в неё приложение приходит при запуске и из партии по «В меню».
	menu = "menu",
	requires = {},
	-- Название вида без своего — ключ словаря «раздел.имя» («units.buggy»), описание — по TITLED. Так и у видов модов,
	-- загруженных раньше этой правки.
	patch = function(protos)
		for section, info in TITLED do
			for name, kind in protos[section] or {} do
				local data = type(kind) == "table" and kind.data
				if type(data) == "table" then
					data.title = data.title or section .. "." .. name
					if info then
						data.info = data.info or info .. "." .. name
					end
				end
			end
		end
	end,
}
