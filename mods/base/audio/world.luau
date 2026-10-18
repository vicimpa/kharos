--!strict
-- Разовые звуки мира по сверке с прошлым кадром — перенос части worldSounds.ts: щит принял удар, пробит, поднялся;
-- створки шахты встали; своему игроку открыта тема или выдана награда — по одному звуку, сколько бы их ни пришло
-- разом; отсчёт перед ядерным ударом — раз в секунду последние countdown секунд по точке удара,
-- которую игрок видит; база гибнет волной после сдачи — сирена (своя — громче и везде); игрок проиграл — аккорд; груз
-- упал на землю — удар ящиков, подобрали — тише.
-- Остальное, что слышно по событиям хоста, приходит сигналами механик (ворота, радар, достроено). Скачок часов мира —
-- новый мир или загрузка: тогда сверять не с чем.

-- Громкость вблизи и как часто один звук может повторяться (VOLUMES, MIN_GAP).
local VOLUMES = { shieldHit = 0.35, shieldDown = 0.6, shieldUp = 0.35, doorsLocked = 0.7, surrender = 0.6, crates = 0.35 }
local MIN_GAP = { shieldHit = 0.08, countdown = 0.5, surrender = 5, researched = 1, crates = 0.15 }
-- Подобранный груз тише: это не событие, а уборка (QUIET).
local QUIET = 0.5
-- Громкость уведомлений и как далеко слышно чужую сдачу (NOTICE_VOLUME, HEARING × 3).
local NOTICE_VOLUME = 0.4
local SURRENDER_REACH = 1.8
-- С какой доли срока пуска створки встали (DOORS); за сколько секунд до удара пищит отсчёт (COUNTDOWN).
local DOORS = 0.35
local COUNTDOWN = 10

local defeat = require("lib/defeat")
local tactics = require("lib/tactics")
-- Скачок часов больше этого, в тиках, — новый мир (JUMP).
local JUMP = 100

local shields: { [number]: { hit: number, up: boolean } } = {}
local doors: { [number]: boolean } = {}
local crates: { [number]: { x: number, y: number } } = {}
local countdown = math.huge
local doomed = 0
local lost = false
-- Сколько тем открыто и наград получено у своего игрока в прошлом кадре; -1 — ещё не считали.
local research, rewards = -1, -1
local last: { [string]: number } = {}
local tick = -1

return {
	update = function(c)
		if not c.audio then
			return
		end
		local fresh = tick < 0 or math.abs(c.tick - tick) > JUMP
		tick = c.tick
		local function play(name: string, x: number?, y: number?, volume: number?, reach: number?)
			if c.clock - (last[name] or -math.huge) < (MIN_GAP[name] or 0) then
				return
			end
			last[name] = c.clock
			c:sound(name, { x = x, y = y, volume = volume or VOLUMES[name], reach = reach })
		end
		local next = {}
		for _, e in c:each({ "Shield", "Position" }) do
			local shield = c:get(e, "Shield")
			local up = shield.charge > 0
			next[e] = { hit = shield.hit, up = up }
			local before = shields[e]
			if fresh or not before then
				continue
			end
			local at = c:get(e, "Position")
			if shield.hit ~= before.hit and up then
				play("shieldHit", at.x, at.y)
			end
			if not up and before.up then
				play("shieldDown", at.x, at.y)
			end
			if up and not before.up then
				play("shieldUp", at.x, at.y)
			end
		end
		shields = next
		-- Створки шахты разошлись до конца — лязг замка.
		local opened = {}
		for _, e in c:each({ "Silo", "Position" }) do
			local silo = c:get(e, "Silo")
			local kind = c:proto(e)
			local warhead = kind and kind.data.warhead
			local open = warhead ~= nil and silo.start >= 0 and (c.tick + c.alpha - silo.start) / math.floor(warhead.launch / c.step + 0.5) >= DOORS
			opened[e] = open
			if open and not fresh and doors[e] == false then
				local at = c:get(e, "Position")
				play("doorsLocked", at.x, at.y)
			end
		end
		doors = opened
		-- Груз: упал — удар ящиков; подобрали — тише.
		local lying = {}
		for _, e in c:each({ "Drop", "Position" }) do
			local at = c:get(e, "Position")
			lying[e] = { x = at.x, y = at.y }
			if not fresh and not crates[e] then
				play("crates", at.x, at.y)
			end
		end
		if not fresh then
			for e, at in crates do
				if not lying[e] then
					play("crates", at.x, at.y, VOLUMES.crates * QUIET)
				end
			end
		end
		crates = lying
		-- Отсчёт: ближайший удар, точку которого игрок видит.
		local left = math.huge
		for _, e in c:each({ "Mark" }) do
			local mark = c:get(e, "Mark")
			if mark.kind == "strike" and (mark.player == c.player or tactics.allied(c, c.player, mark.player) or table.find(mark.viewers or {}, c.player)) then
				left = math.min(left, (mark["until"] - c.tick) * c.step)
			end
		end
		local second = math.ceil(left)
		if second <= COUNTDOWN and second < countdown and c.clock - (last.countdown or -math.huge) >= MIN_GAP.countdown then
			last.countdown = c.clock
			c:sound("countdown", { volume = 0.4 })
		end
		countdown = second
		-- Капитуляция: база гибнет волной. Юнит, которого игрок уничтожил сам, — не капитуляция.
		local doom, doomAt, own = 0, nil, false
		for _, e in c:each({ "Doomed", "Position" }) do
			if c:get(e, "Doomed").scuttled then
				continue
			end
			doom += 1
			doomAt = doomAt or c:get(e, "Position")
			own = own or c:mine(e)
		end
		if not fresh and doom > 0 and doomed == 0 then
			if own then
				play("surrender", nil, nil, NOTICE_VOLUME * 1.5)
			elseif doomAt then
				play("surrender", doomAt.x, doomAt.y, nil, SURRENDER_REACH)
			end
		end
		doomed = doom
		-- Поражение.
		local defeated = c.tick > 0 and defeat.isDefeated(c, c.player)
		if not fresh and defeated and not lost then
			play("defeat", nil, nil, NOTICE_VOLUME * 1.5)
		end
		lost = defeated
		-- Открытые темы и награды: прибавилось — уведомление, где бы ни была камера.
		for _, e in c:each({ "Player" }) do
			local state = c:get(e, "Player")
			if state.id ~= c.player then
				continue
			end
			local learned, got = #(state.research or {}), #(state.rewards or {})
			if not fresh and research >= 0 and learned > research then
				play("researched", nil, nil, NOTICE_VOLUME)
			end
			if not fresh and rewards >= 0 and got > rewards then
				play("reward", nil, nil, NOTICE_VOLUME)
			end
			research, rewards = learned, got
		end
	end,
}
