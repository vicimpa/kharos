--!strict
-- Сигнал союзникам: Alt+щелчок по карте в сетевой игре (pings.ts). Щелчок уходит на сигнал — выделению и приказам
-- он не достаётся.

local ping = {}

function ping.update(c)
	local input = c.input
	if c.online and input.keys.alt and input.pressed.left and input.inside and not input.over_ui and not c.shared.paused then
		c:send("ping", { x = input.wx, y = input.wy })
		input.pressed.left = false
	end
end

return ping
