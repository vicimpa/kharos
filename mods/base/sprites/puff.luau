--!strict
-- Клуб дыма — три разных (drawPuff в combatPass.ts): несколько кругов вразброс, светлые сверху и тёмные снизу. Цвет
-- задаёт оттенок спрайта: тот же клуб — и дым, и пыль.

local noise = require("lib/noise").of

local FRAME = 16
local KINDS = 3
local LOBES = 5

local function draw(g, _, kind: number)
	local center = FRAME / 2
	for _, layer in { { 1, 0xa8a8ae }, { 0, 0xe6e6ea } } do
		local shift, color = layer[1], layer[2]
		g:circle(center, center + shift, 3.5, color)
		for i = 0, LOBES - 1 do
			local angle = (i / LOBES) * math.pi * 2 + noise(i, kind) * 1.2
			local reach = 2.2 + noise(i, kind + 7) * 1.4
			g:circle(math.round(center + math.cos(angle) * reach), math.round(center + math.sin(angle) * reach) + shift, 2 + noise(i, kind + 13) * 1.2, color)
		end
	end
end

return {
	data = { kinds = KINDS },
	look = { size = FRAME, origin = { 0, 0 }, phases = KINDS, draw = draw },
}
