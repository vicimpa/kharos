--!strict
-- Схватка: каждому вошедшему — завод и три багги на своём месте карты, стартовые кредиты. Подача — камера RTS,
-- выделение рамкой и приказы мышью, панель с кредитами и производством, погода и звук как в Kharos.

local skirmish = {}

skirmish.data = {
	title = "Схватка",
	credits = 1000,
	-- С чем начинает игрок: виды и сколько.
	start = { buggy = 3 },
	-- Места игроков — по кругу такого радиуса, в тайлах.
	radius = 24,
	-- Поле: от −size до size по обеим осям.
	size = 128,
	-- Местность — вид из lands/.
	land = "desert",
	-- Правила мира: замедление на местности по родам юнитов.
	rules = require("lib/rules"),
}

-- Место игрока: первый — в центре, остальные — по кругу.
local function home(player: number): (number, number)
	if player <= 1 then
		return 0, 0
	end
	local angle = (player - 2) * math.pi * 2 / 6
	return math.cos(angle) * skirmish.data.radius, math.sin(angle) * skirmish.data.radius
end

skirmish.on = {
	player_joined = function(ctx, event)
		local player = event.player
		local x, y = home(player)
		-- Здание — по тайлам: середина завода 3 × 3 — в середине тайла.
		local tx, ty = math.floor(x), math.floor(y)
		ctx:spawn("buildings/factory", { Position = { x = tx + 0.5, y = ty + 0.5 }, Owner = { player = player } })
		-- Машины — когда завод уже стоит: их места ищутся вокруг него.
		ctx:emit("base_built", { player = player, x = tx, y = ty })
	end,
	-- Стартовые машины — на свободных тайлах вокруг завода (spawnStartingUnits).
	base_built = function(ctx, event)
		local list = {}
		for name, amount in skirmish.data.start do
			for _ = 1, amount do
				table.insert(list, name)
			end
		end
		local tiles = ctx:free_tiles(event.x, event.y, #list)
		for i, name in list do
			if i * 2 > #tiles then
				break
			end
			ctx:spawn("units/" .. name, { Position = { x = tiles[i * 2 - 1] + 0.5, y = tiles[i * 2] + 0.5 }, Owner = { player = event.player } })
		end
	end,
}

-- Подача: что клиент берёт из модов для этой партии (имена видов в своих разделах).
skirmish.client = {
	camera = "rts",
	controls = { "select", "orders" },
	ui = { "hud", "pause" },
	atmosphere = { "weather" },
	effects = { "traces", "combat" },
	-- Звук — как в TS: интерфейс, моторы, работа зданий, фон с подложкой и эхом, ветер полёта.
	audio = { "levels", "interface", "motors", "machines", "ambience", "flight" },
}

return skirmish
