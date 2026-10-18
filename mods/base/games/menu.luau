--!strict
-- Главное меню — тоже партия: под окнами меню (ui/menu) идёт витрина — слайды-сценки на каждый раз новой крошечной
-- местности, в случайный час и свою погоду (gui/screens/showcase.ts). Какую сценку вести, решает панель витрины
-- (ui/showcase) и передаёт в data.scene через c.app:reset. Сценка — вид из scenes/: create заводит мир, drive ведёт
-- его раз в полсекунды и возвращает false, когда сценка кончилась.

local menu = {}

menu.data = {
	title = "Главное меню",
	land = "desert",
	-- Карта витрины крошечная: её считают с нуля для каждого слайда (SHOWCASE_SIZE — 128 тайлов).
	size = 64,
	fog = false,
	-- Правила — как в партии, но без боеприпасов юнитов: сценка про бой, а не про снабжение (unitAmmo: false).
	rules = (function()
		local rules = table.clone(require("lib/rules"))
		rules.unitAmmo = false
		return rules
	end)(),
	-- Как часто сценка ведёт свой мир, в секундах (DRIVE_INTERVAL).
	drive = 0.5,
}

-- Игрок, за которого играет витрина (LOCAL_PLAYER).
local PLAYER = 1

local function scene(ctx)
	local name = ctx.game.data.scene
	return name and ctx.protos.scenes[name]
end

-- Заводит мир сценки — в первом тике: к нему партия уже разложила месторождения (событие start), а на них стоит
-- тестовая база «добычи».
local function create(ctx)
	local kind = scene(ctx)
	ctx.storage.created = true
	if kind and not kind.create(ctx, PLAYER) then
		ctx:signal("scene_failed", { scene = kind.name })
	end
end

menu.systems = {
	create = {
		run = function(_, ctx)
			if not ctx.storage.created then
				create(ctx)
			end
		end,
	},
	-- Сценка ведёт свой мир; кончилась — витрина пусть доиграет пару секунд и сменяет слайд.
	drive = {
		every = 10,
		run = function(_, ctx)
			local kind = scene(ctx)
			if not kind or not kind.drive or ctx.storage.ended or not ctx.storage.created then
				return
			end
			if not kind.drive(ctx, PLAYER, menu.data.drive) then
				ctx.storage.ended = true
				ctx:signal("scene_over", { scene = kind.name })
			end
		end,
	},
}

menu.client = {
	camera = "showcase",
	-- Витрина — первой: её затемнение лежит под окнами меню.
	ui = { "showcase", "menu" },
	atmosphere = { "weather" },
	effects = { "traces", "paving", "drops", "construction", "power", "logistics", "connections", "flow", "combat", "conversion", "silos" },
	audio = { "levels", "interface", "music" },
}

return menu
