--!strict
-- Набор патруля: P или кнопка «Патруль» включают режим c.shared.mode, щелчок по карте — бойцы патрулируют между своим
-- местом и точкой, и режим кончается; Shift+щелчок — ещё точка к патрулю, режим продолжается. Рамка или щелчок по
-- своему невыбранному юниту — обычное выделение, набор кончается. Правая кнопка и Esc — отмена; бойцов среди выбранных
-- не осталось — режим кончается сам. Касанием — то же, что щелчок.

local tactics = require("lib/tactics")

local patrol = {}

patrol.data = {
	-- Сдвиг указателя, после которого щелчок становится рамкой, в пикселях.
	threshold = 6,
}

local pressed: { x: number, y: number }? = nil

-- Свои выбранные бойцы.
local function fighters(c): { number }
	local list = {}
	local turrets = tactics.mounts(c)
	for _, e in c.shared.selection or {} do
		if c:alive(e) and c:mine(e) and c:has(e, "Unit") and tactics.canFight(c, e, turrets[e]) then
			table.insert(list, e)
		end
	end
	return list
end

-- Включает набор патруля, если среди выбранных есть бойцы, или бросает его (start = false).
function patrol.toggle(c, start: boolean)
	local shared = c.shared
	if not start then
		if shared.mode and shared.mode.kind == "patrolling" then
			shared.mode = nil
		end
		return
	end
	if #fighters(c) > 0 then
		-- Набор патруля — режим, в котором рамка остаётся выделением (controls/select).
		shared.mode = { kind = "patrolling", selects = true }
	end
end

function patrol.update(c)
	local shared, input = c.shared, c.input
	if shared.paused then
		pressed = nil
		return
	end
	-- P — патруль, как в StarCraft: дальше щелчок по карте.
	if input.hits.p and not input.keys.ctrl and not input.keys.alt then
		patrol.toggle(c, true)
	end
	local mode = shared.mode
	if not mode or mode.kind ~= "patrolling" then
		pressed = nil
		return
	end
	local units = fighters(c)
	if #units == 0 then
		shared.mode = nil
		return
	end
	if input.hits.escape then
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	if input.pressed.right and input.inside and not input.over_ui then
		shared.mode = nil
		shared.modeClosedAt = c.time
		return
	end
	if input.pressed.left and input.inside and not input.over_ui then
		pressed = { x = input.x, y = input.y }
	end
	local start = pressed
	if start and input.released.left then
		pressed = nil
		local dragged = math.abs(input.x - start.x) + math.abs(input.y - start.y) > patrol.data.threshold
		local picked = if dragged then nil else c:pick(input.wx, input.wy)
		-- Рамка или свой невыбранный юнит — выделение: его сделает controls/select.
		if dragged or (picked and c:mine(picked) and c:has(picked, "Unit") and not table.find(shared.selection or {}, picked)) then
			shared.mode = nil
			return
		end
		c:send("patrol", { units = units, points = { math.floor(input.wx), math.floor(input.wy) }, append = input.keys.shift })
		c:sound("order", { volume = 0.35 })
		-- Щелчок — точка патруля, а не выделение.
		shared.swallow = true
		if not input.keys.shift then
			shared.mode = nil
		end
	end
end

return patrol
