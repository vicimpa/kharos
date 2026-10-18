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
		ctx:spawn("buildings/factory", { Position = { x = x, y = y }, Owner = { player = player } })
		local count = 0
		for name, amount in skirmish.data.start do
			for _ = 1, amount do
				count += 1
				local ux, uy = x - 2 + count * 1.4, y + 4
				ctx:spawn("units/" .. name, { Position = { x = ux, y = uy }, Facing = { angle = math.pi / 2 }, Owner = { player = player } })
			end
		end
	end,
}

-- Подача: что клиент берёт из модов для этой партии (имена видов в своих разделах).
skirmish.client = {
	camera = "rts",
	controls = { "select", "orders" },
	ui = { "hud", "pause" },
	atmosphere = { "weather" },
	effects = { "traces" },
	-- Звук — как в TS: интерфейс, моторы, работа зданий, фон с подложкой и эхом, ветер полёта.
	audio = { "levels", "interface", "motors", "machines", "ambience", "flight" },
}

return skirmish
