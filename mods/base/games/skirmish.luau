--!strict
-- Схватка: каждый вошедший появляется со стартовым набором — MCV, две багги и взвод пехоты, — и стартовыми кредитами;
-- первый — у начала мира, но не в кармане за обрывами. Подача — камера RTS, выделение рамкой и приказы мышью, панель с
-- кредитами, производством и стройкой, погода и звук как в Kharos.

local skirmish = {}

-- Эффекты мира, поверх них — цель первого шага.
local effects = table.clone(require("lib/effects"))
table.insert(effects, "steps")

skirmish.data = {
	-- Строителей заказывают в развёрнутом главном здании, на это кредиты и есть.
	credits = 1500,
	-- С чем появляется игрок, по порядку: MCV встаёт на само место, остальные — вокруг.
	start = { "mcv", "buggy", "buggy", "infantry", "infantry", "infantry" },
	-- Места остальных игроков — по кругу такого радиуса, в тайлах.
	radius = 24,
	-- Поле: от −size до size по обеим осям.
	size = 128,
	-- Местность — вид из lands/.
	land = "desert",
	-- Правила мира: замедление на местности по родам юнитов.
	rules = require("lib/rules"),
	-- Сколько тайлов вокруг места появления должно быть доступно технике, иначе база заперта обрывами; шаг и радиус
	-- поиска такого места.
	room = 2000,
	spawnStep = 4,
	spawnRadius = 64,
}

-- Место игрока: первый — в начале мира, остальные — по кругу.
local function home(player: number): (number, number)
	if player <= 1 then
		return 0, 0
	end
	local angle = (player - 2) * math.pi * 2 / 6
	return math.floor(math.cos(angle) * skirmish.data.radius), math.floor(math.sin(angle) * skirmish.data.radius)
end

-- Не заперто ли место: техника отсюда доедет хотя бы до room тайлов.
local function open(ctx, x: number, y: number): boolean
	return ctx:can_stand("vehicle", x, y) and ctx:reach(x, y, skirmish.data.room) >= skirmish.data.room
end

-- Ближайшее к (x, y) незапертое место кольцами наружу; не нашлось — сама точка.
local function openSpawn(ctx, x: number, y: number): (number, number)
	local step = skirmish.data.spawnStep
	for ring = 0, skirmish.data.spawnRadius, step do
		for dy = -ring, ring, step do
			for dx = -ring, ring, step do
				if math.max(math.abs(dx), math.abs(dy)) == ring and open(ctx, x + dx, y + dy) then
					return x + dx, y + dy
				end
			end
		end
	end
	return x, y
end

skirmish.on = {
	-- Стартовый набор — на свободных тайлах вокруг места, через тайл; не хватило мест — меньше.
	player_joined = function(ctx, event)
		local x, y = openSpawn(ctx, home(event.player))
		local list = skirmish.data.start
		local tiles = ctx:free_tiles(x, y, #list)
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
	-- Выбор места — первым: его Esc и щелчки не достаются выделению.
	controls = { "deploy", "build", "stroke", "patrol", "trucks", "aim", "select", "orders" },
	ui = { "hud", "tech", "pause" },
	atmosphere = { "weather" },
	effects = effects,
	-- Звук: интерфейс, моторы, работа зданий, фон с подложкой и эхом, ветер полёта.
	audio = { "levels", "interface", "motors", "machines", "world", "battle", "ambience", "flight" },
}

-- Редактор этой партии: мир стоит, вместо нижней панели — панель редактора справа, мышь — инструменты редактора; тумана
-- нет.
skirmish.editor = {
	camera = "rts",
	controls = { "editor" },
	ui = { "editor" },
	atmosphere = { "weather" },
	effects = require("lib/effects"),
	audio = { "levels", "interface" },
}

return skirmish
