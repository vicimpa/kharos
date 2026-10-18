--!strict
-- Разовые звуки мира по сверке с прошлым кадром — перенос части worldSounds.ts: щит принял удар, пробит, поднялся;
-- створки шахты встали; отсчёт перед ядерным ударом — раз в секунду последние countdown секунд по точке удара,
-- которую игрок видит.
-- Остальное, что слышно по событиям хоста, приходит сигналами механик (ворота, радар, достроено). Скачок часов мира —
-- новый мир или загрузка: тогда сверять не с чем.

-- Громкость вблизи и как часто один звук может повторяться (VOLUMES, MIN_GAP).
local VOLUMES = { shieldHit = 0.35, shieldDown = 0.6, shieldUp = 0.35, doorsLocked = 0.7 }
local MIN_GAP = { shieldHit = 0.08, countdown = 0.5 }
-- С какой доли срока пуска створки встали (DOORS); за сколько секунд до удара пищит отсчёт (COUNTDOWN).
local DOORS = 0.35
local COUNTDOWN = 10

local tactics = require("lib/tactics")
-- Скачок часов больше этого, в тиках, — новый мир (JUMP).
local JUMP = 100

local shields: { [number]: { hit: number, up: boolean } } = {}
local doors: { [number]: boolean } = {}
local countdown = math.huge
local last: { [string]: number } = {}
local tick = -1

return {
	update = function(c)
		if not c.audio then
			return
		end
		local fresh = tick < 0 or math.abs(c.tick - tick) > JUMP
		tick = c.tick
		local function play(name: string, x: number, y: number)
			if c.clock - (last[name] or -math.huge) < (MIN_GAP[name] or 0) then
				return
			end
			last[name] = c.clock
			c:sound(name, { x = x, y = y, volume = VOLUMES[name] })
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
	end,
}
