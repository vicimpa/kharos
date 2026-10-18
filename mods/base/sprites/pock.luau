--!strict
-- Щербинки от пуль (drawPock в decalsPass.ts): несколько тёмных пикселей вразброс, три варианта.

local noise = require("lib/noise").of

local function draw(g, _, variant: number)
	for i = 0, 3 do
		local x = math.floor(1 + noise(i, variant, 3) * 4)
		local y = math.floor(1 + noise(i, variant, 5) * 4)
		g:set(x, y, if i > 0 then 0x241c15 else 0x120e0b)
	end
end

return {
	data = { variants = 3, frame = 6 },
	look = { size = 6, origin = { 0, 0 }, phases = 3, draw = draw },
}
