--!strict
-- Тактика на панели: свои бойцы без строителей — стойки (общая горит, если она у всех одна) и патруль.

local tactics = require("lib/tactics")

-- Стойки бойцов: подпись и подсказка.
local STANCES = {
	aggressive = { label = "grid.stances.aggressive", tip = "grid.stanceTips.aggressive" },
	defensive = { label = "grid.stances.defensive", tip = "grid.stanceTips.defensive" },
	hold = { label = "grid.stances.hold", tip = "grid.stanceTips.hold" },
	passive = { label = "grid.stances.passive", tip = "grid.stanceTips.passive" },
}

local function slots(c, list, view)
	if #view.builders > 0 then
		return
	end
	local units, stance, patrolling = {}, nil, 0
	local turrets = tactics.mounts(c)
	for _, e in view.selection do
		if c:mine(e) and c:has(e, "Unit") and tactics.canFight(c, e, turrets[e]) then
			local own = tactics.stanceOf(c, e)
			stance = if #units == 0 or stance == own then own else ""
			table.insert(units, e)
			local state = c:get(e, "Tactics")
			if state and #state.patrol > 0 then
				patrolling += 1
			end
		end
	end
	if #units == 0 then
		return
	end
	for i, name in tactics.stances do
		list[i] = {
			label = c:t(STANCES[name].label),
			title = c:t(STANCES[name].tip, { leash = tactics.leash }),
			active = stance == name,
			run = function()
				c:send("stance", { units = units, stance = name })
			end,
		}
	end
	local picking = c.shared.mode ~= nil and c.shared.mode.kind == "patrolling"
	list[5] = {
		label = c:t("grid.patrol"),
		title = c:t("grid.patrolTip"),
		active = picking or patrolling > 0,
		run = function()
			c.shared.mode = if picking then nil else { kind = "patrolling", selects = true }
		end,
	}
end

return {
	slots = { { at = 30, fill = slots } },
}
