--!strict
-- Витрина под главным меню — перенос gui/screens/showcase.ts: слайды-сценки (виды scenes/) на каждый раз новой
-- крошечной местности, в случайный час и свою погоду. Мир начинает заново c.app:reset, панели меню при этом не
-- трогаются. Сценка, которая не встала или кончилась раньше времени, сменяется следующей; между слайдами экран
-- темнеет. Затемнение рисуется первым — под окнами меню.

local showcase = {}

showcase.data = {
	-- Сколько длится слайд и затемнение между слайдами, в секундах.
	slide = 40,
	fade = 1.2,
	-- Пока местность первого кадра собирается, экран тёмный.
	settle = 0.7,
	-- После того как сценка кончилась, она доигрывает столько секунд.
	linger = 2.5,
	-- Затемнение, пока слайд идёт.
	veil = 0.25,
}

local NIGHT = "8 17 28"

local scene: string? = nil
local shown = false
local changed = 0
local from = 1
local veil = 1
local timers: { { at: number, action: () -> () } } = {}
local draws = 0

local function random(c, salt: number): number
	draws += 1
	return c.hash(c.time * 1000 + draws * 7.31, draws, salt)
end

local function show(c, on: boolean)
	if on == shown then
		return
	end
	from = veil
	changed = c.time
	shown = on
end

local function later(c, delay: number, action: () -> ())
	table.insert(timers, { at = c.time + delay, action = action })
end

local function names(c): { string }
	local list = {}
	for name in c.protos.scenes or {} do
		table.insert(list, name)
	end
	table.sort(list)
	return list
end

-- Следующая сценка — случайная, но не та же, что сейчас.
local function nextScene(c): string?
	local choices = {}
	for _, name in names(c) do
		if name ~= scene then
			table.insert(choices, name)
		end
	end
	if #choices == 0 then
		return scene
	end
	return choices[math.floor(random(c, 3) * #choices) + 1]
end

-- Слайд: новый мир со сценкой name, случайным зерном и погодой — чаще днём, сутки быстрые: за слайд свет заметно
-- смещается.
local slide: (any, string) -> ()
local function advance(c)
	show(c, false)
	later(c, showcase.data.fade, function()
		local name = nextScene(c)
		if name then
			slide(c, name)
		end
	end)
end

slide = function(c, name: string)
	timers = {}
	scene = name
	local day = random(c, 5) < 0.75
	local hour = if day then 7 + random(c, 7) * 11 else random(c, 11) * 24
	c.app:reset({ scene = name, seed = math.floor(random(c, 13) * 2 ^ 31), weather = { startHour = hour, dayLength = 600, changes = true } })
	later(c, showcase.data.settle, function()
		show(c, true)
	end)
	later(c, showcase.data.slide - showcase.data.fade, function()
		advance(c)
	end)
end

-- Сигналы витрины от партии меню: сценка не встала — следующая сразу; кончилась — пусть доиграет и сменится.
showcase.signals = {
	scene_failed = function(c)
		timers = {}
		local name = nextScene(c)
		if name then
			slide(c, name)
		end
	end,
	scene_over = function(c)
		timers = {}
		later(c, showcase.data.linger, function()
			advance(c)
		end)
	end,
}

function showcase.draw(c)
	if #names(c) == 0 then
		return
	end
	if not scene then
		local name = nextScene(c)
		if name then
			slide(c, name)
		end
	end
	-- Сработавшие отсрочки — по порядку; новые, заведённые ими, ждут своего времени.
	local due = {}
	local rest = {}
	for _, timer in timers do
		table.insert(if timer.at <= c.time then due else rest, timer)
	end
	timers = rest
	for _, timer in due do
		timer.action()
	end
	local share = math.min(1, (c.time - changed) / showcase.data.fade)
	veil = from + ((if shown then showcase.data.veil else 1) - from) * share
	-- Ступенями по 1/16: плавнее не разглядеть.
	c.ui:box({ anchor = { left = 0, right = 0, top = 0, bottom = 0 }, background = string.format("rgb(%s / %g)", NIGHT, math.round(veil * 16) / 16), passive = true })
end

return showcase
