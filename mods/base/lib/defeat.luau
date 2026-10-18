--!strict
-- Поражение и сдача — правила, общие для хоста (ctx) и клиента (c): проиграл ли игрок и кого из выбранных он может
-- уничтожить сам. Приказы — mechanics/defeat.

local conversion = require("lib/conversion")

local defeat = {}

-- Проиграл ли игрок: у него не осталось ни одного готового здания и нет MCV. Пока стоит хоть одно готовое здание, база
-- жива: без главного здания она всё равно держит зону, даёт доход и строит. Стройка и разбираемое не считаются. Игрока,
-- которого в мире ещё нет, проигравшим не считают.
function defeat.isDefeated(w, player: number): boolean
	local known = false
	for _, e in w:each({ "Player" }) do
		if w:get(e, "Player").id == player then
			known = true
			break
		end
	end
	if not known then
		return false
	end
	local mcv = conversion.unit(w)
	for _, e in w:each({ "Owner" }) do
		if w:get(e, "Owner").player ~= player then
			continue
		end
		if w:has(e, "Building") and not w:has(e, "Site") then
			return false
		end
		if w:has(e, "Unit") then
			local proto = w:get(e, "Proto")
			if proto and mcv and proto.id == mcv.id then
				return false
			end
		end
	end
	return true
end

-- Кого из названных можно отдать или уничтожить (giftable): свои живые юниты, не турели на носителе и не обречённые.
function defeat.giftable(w, player: number, units: any): { number }
	local list, seen = {}, {}
	if type(units) ~= "table" then
		return list
	end
	for _, e in units do
		if type(e) ~= "number" or seen[e] or not w:alive(e) then
			continue
		end
		seen[e] = true
		local owner = w:get(e, "Owner")
		if owner and owner.player == player and w:has(e, "Unit") and not w:has(e, "Attached") and not w:has(e, "Doomed") then
			table.insert(list, e)
		end
	end
	return list
end

return defeat
