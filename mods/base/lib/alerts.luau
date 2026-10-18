--!strict
-- Уведомления игрока. Раз в кадр сверяет мир с прошлым: у своего юнита или здания убыло прочности, а рядом упал чужой
-- выстрел — «атакованы»; в виду появился чужой юнит — «замечен противник» (не чаще spottedGap); игрок разведал новое
-- месторождение — «найдено месторождение» (не чаще foundGap). Об атаке предупреждают раз: снова — когда враги пропали
-- из виду и напали опять. Чужая ядерная ракета взлетела — «ядерный пуск»: её видят все. Чужая метка точки удара,
-- которую игрок видит, — «ядерный удар по нам», а за warning секунд до удара — второй сигнал, громче и выше. Свой или
-- союзный перехватчик выпустил ракету — «ракета перехвачена»; своя ядерная пропала, не долетев, — «нашу ракету сбили».
-- Каждое уведомление — строка в ленте, сигнал и кольцо на мини-карте. Только клиенту.

local missiles = require("lib/missiles")
local tactics = require("lib/tactics")

local alerts = {}

alerts.data = {
	-- Не чаще скольких секунд «замечен противник» и «найдено месторождение»; сколько секунд строка висит в ленте и
	-- кольцо мигает на мини-карте; сколько строк держит лента.
	spottedGap = 12,
	foundGap = 6,
	seconds = 8,
	limit = 4,
	-- Атака — урон, рядом с которым упал чужой выстрел: не дальше hitReach тайлов от края, не раньше hitMemory секунд
	-- назад; своя ракета пропала дальше downedReach от точки удара — сбита; за сколько секунд до удара второй сигнал;
	-- громкость сигналов.
	hitReach = 3,
	hitMemory = 1.5,
	downedReach = 2,
	warning = 15,
	volume = 0.7,
}

-- Что сказать: вид уведомления → строка.
alerts.TEXTS = {
	spotted = "hud.alerts.spotted",
	baseAttacked = "hud.alerts.baseAttacked",
	unitsAttacked = "hud.alerts.unitsAttacked",
	oreFound = "hud.alerts.oreFound",
	nukeLaunched = "hud.alerts.nukeLaunched",
	nukeIncoming = "hud.alerts.nukeIncoming",
	nukeImminent = "hud.alerts.nukeImminent",
	nukeIntercepted = "hud.alerts.nukeIntercepted",
	nukeDowned = "hud.alerts.nukeDowned",
}

export type Alert = { kind: string, text: string, x: number, y: number, at: number }

local clock = 0
local list: { Alert } = {}
local health: { [number]: number } = {}
local foes: { [number]: boolean } = {}
local warned = false
local spottedAt = -math.huge
local foundAt = -math.huge
local impacts: { [number]: { x: number, y: number, at: number } } = {}
local known: { [number]: boolean }? = nil
local marks: { [number]: boolean } = {}
local imminent: { [number]: boolean } = {}
local launches: { [number]: boolean } = {}
local chasers: { [number]: boolean } = {}
local flights: { [number]: { x: number, y: number, toX: number, toY: number } } = {}
local lastTick = -1

local function raise(c, kind: string, text: string, x: number, y: number, sound: string?, volume: number?)
	table.insert(list, { kind = kind, text = text, x = x, y = y, at = clock })
	if #list > alerts.data.limit then
		table.remove(list, 1)
	end
	c:sound(sound or kind, { volume = volume or alerts.data.volume })
end

-- Свой или союзный игрок.
local function friendly(c, player: number): boolean
	return player == c.player or tactics.allied(c, c.player, player)
end

-- Раз в кадр: сверка с прошлым кадром. Возвращает уведомления, которые ещё видны: от старых к новым.
function alerts.update(c): { Alert }
	local d = alerts.data
	-- Другой мир (новая партия, загрузка): сверять не с чем.
	if c.tick < lastTick then
		list, health, foes, impacts, known, marks, imminent, launches, chasers, flights = {}, {}, {}, {}, nil, {}, {}, {}, {}, {}
	end
	lastTick = c.tick
	clock += c.dt

	-- Чужие юниты в виду: новый — «замечен противник».
	local nextFoes = {}
	local spotted = nil
	for _, e in c:each({ "Unit", "Owner", "Position" }) do
		local owner = c:get(e, "Owner").player
		if owner == 0 or friendly(c, owner) then
			continue
		end
		local at = c:get(e, "Position")
		if not c:sees(at.x, at.y) then
			continue
		end
		nextFoes[e] = true
		if not foes[e] and not spotted then
			spotted = at
		end
	end
	foes = nextFoes
	if next(foes) == nil then
		warned = false
	end

	-- Метки точки удара, которые игрок видит: первый сигнал — когда узнал, второй, громче, — когда до удара мало.
	local nextMarks, nextImminent = {}, {}
	for _, e in c:each({ "Mark", "Position" }) do
		local mark = c:get(e, "Mark")
		if mark.kind ~= "strike" or friendly(c, mark.player) or not table.find(mark.viewers or {}, c.player) then
			continue
		end
		nextMarks[e] = true
		local at = c:get(e, "Position")
		if (mark["until"] - c.tick) * c.step <= d.warning then
			nextImminent[e] = true
			if not imminent[e] then
				raise(c, "nuke", "nukeImminent", at.x, at.y, "nukeClose", 1)
			end
		elseif not marks[e] then
			raise(c, "nuke", "nukeIncoming", at.x, at.y)
		end
	end
	marks, imminent = nextMarks, nextImminent

	-- Свой или союзный перехватчик выпустил ракету.
	local nextChasers = {}
	for _, e in c:each({ "Chaser" }) do
		nextChasers[e] = true
		local chaser = c:get(e, "Chaser")
		if not chasers[e] and friendly(c, chaser.player) then
			raise(c, "intercepted", "nukeIntercepted", chaser.toX, chaser.toY)
		end
	end
	chasers = nextChasers

	-- Чужая ракета взлетела — сирена всем; своя пропала далеко от точки удара — её сбили.
	local speed = c.protos.buildings.silo.data.warhead.speed
	local nextFlights, nextLaunches = {}, {}
	for _, e in c:each({ "Missile" }) do
		local missile = c:get(e, "Missile")
		if missile.player ~= c.player then
			nextLaunches[e] = true
			if not launches[e] and not friendly(c, missile.player) then
				raise(c, "nuke", "nukeLaunched", missile.fromX, missile.fromY)
			end
			continue
		end
		local x, y = missiles.at(missile, c.tick + c.alpha, c.step, speed)
		nextFlights[e] = { x = x, y = y, toX = missile.toX, toY = missile.toY }
	end
	for e, flight in flights do
		if not nextFlights[e] and math.sqrt((flight.toX - flight.x) ^ 2 + (flight.toY - flight.y) ^ 2) > d.downedReach then
			raise(c, "nuke", "nukeDowned", flight.x, flight.y)
		end
	end
	flights, launches = nextFlights, nextLaunches

	if spotted and clock - spottedAt >= d.spottedGap then
		spottedAt = clock
		raise(c, "spotted", "spotted", spotted.x, spotted.y)
	end

	-- Месторождения игрок знает разведанными: новое разведанное — найдено. В первый кадр всё знакомо.
	local nextKnown, fresh = {}, nil
	for _, e in c:each({ "Deposit", "Position" }) do
		local at = c:get(e, "Position")
		if c:knows(e) then
			nextKnown[e] = true
			if known and not known[e] and not fresh then
				fresh = at
			end
		end
	end
	known = nextKnown
	if fresh and clock - foundAt >= d.foundGap then
		foundAt = clock
		raise(c, "found", "oreFound", fresh.x, fresh.y)
	end

	-- Куда недавно падали чужие выстрелы.
	for _, e in c:each({ "Shot" }) do
		local shot = c:get(e, "Shot")
		if shot.player ~= c.player and shot.player ~= 0 and not impacts[e] then
			impacts[e] = { x = shot.toX, y = shot.toY, at = clock }
		end
	end
	for e, impact in impacts do
		if clock - impact.at > d.hitMemory then
			impacts[e] = nil
		end
	end
	local function shotAt(left: number, top: number, width: number, height: number): boolean
		for _, impact in impacts do
			local dx = math.max(left - impact.x, 0, impact.x - (left + width))
			local dy = math.max(top - impact.y, 0, impact.y - (top + height))
			if math.sqrt(dx * dx + dy * dy) <= d.hitReach then
				return true
			end
		end
		return false
	end
	-- Своё, у чего убыло прочности рядом с чужим выстрелом, — атаковано.
	local nextHealth, hurt = {}, nil
	for _, e in c:each({ "Health", "Owner", "Position" }) do
		if c:get(e, "Owner").player ~= c.player then
			continue
		end
		local value = c:get(e, "Health").value
		nextHealth[e] = value
		local before = health[e]
		if hurt or not before or value >= before - 1e-6 then
			continue
		end
		local at = c:get(e, "Position")
		local size = c:get(e, "Building")
		local width, height = if size then size.width else 0, if size then size.height else 0
		if shotAt(at.x - width / 2, at.y - height / 2, width, height) then
			hurt = e
		end
	end
	health = nextHealth
	if hurt and not warned then
		warned = true
		local at = c:get(hurt, "Position")
		raise(c, "attacked", if c:has(hurt, "Building") then "baseAttacked" else "unitsAttacked", at.x, at.y)
	end

	while #list > 0 and clock - list[1].at > d.seconds do
		table.remove(list, 1)
	end
	return list
end

-- Сколько секунд назад было уведомление.
function alerts.age(alert: Alert): number
	return clock - alert.at
end

return alerts
