--!strict
-- Разовые звуки мира по сверке с прошлым кадром — перенос части worldSounds.ts: щит принял удар, пробит, поднялся.
-- Остальное, что слышно по событиям хоста, приходит сигналами механик (ворота, радар, достроено). Скачок часов мира —
-- новый мир или загрузка: тогда сверять не с чем.

-- Громкость вблизи и как часто один звук может повторяться (VOLUMES, MIN_GAP).
local VOLUMES = { shieldHit = 0.35, shieldDown = 0.6, shieldUp = 0.35 }
local MIN_GAP = { shieldHit = 0.08 }
-- Скачок часов больше этого, в тиках, — новый мир (JUMP).
local JUMP = 100

local shields: { [number]: { hit: number, up: boolean } } = {}
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
	end,
}
