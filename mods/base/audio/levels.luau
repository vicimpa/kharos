--!strict
-- Громкость по настройкам игрока (lib/settings): общая и групп, выключенный звук — тишина. Меняют в окне настроек —
-- звук подстраивается сразу.

local settings = require("lib/settings")

local applied = ""

return {
	update = function(c)
		local audio = c.audio
		if not audio then
			return
		end
		local muted = settings.muted(c)
		local master = if muted then 0 else settings.volume(c)
		local levels = {}
		for _, channel in settings.CHANNELS do
			levels[channel] = settings.level(c, channel)
		end
		local signature = string.format("%g|%g|%g|%g|%g", master, levels.music, levels.battle, levels.world, levels.interface)
		if signature == applied then
			return
		end
		applied = signature
		audio:volume("master", master)
		for channel, level in levels do
			audio:volume(channel, level)
		end
	end,
}
