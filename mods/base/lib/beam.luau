--!strict
-- Транспортный луч — перенос beamFor, reaches и transfer из inventory.ts: переносит груз между складом своей сущности и
-- чужим, если между их краями не больше радиуса луча. Очереди нет: луч работает со всеми в радиусе сразу, каждому —
-- до rate в секунду. links — с кем он работал в этот тик: так подача рисует лучи. w — ctx или книга (goods.book).

local goods = require("lib/goods")
local approach = require("lib/approach")

local beams = {}

-- Чей луч перенесёт груз со склада from на склад to (beamFor): отдающий from или забирающий to; годятся оба — тот, что
-- дальше дотягивается.
function beams.beamFor(w, from: number, to: number): number?
	if not w:get(from, "Inventory") or not w:get(to, "Inventory") then
		return nil
	end
	local giving, taking = w:get(from, "Beam"), w:get(to, "Beam")
	local best, radius = nil, -1
	if giving and giving.give then
		best, radius = from, giving.radius
	end
	if taking and taking.take and taking.radius > radius then
		best = to
	end
	return best
end

function beams.reaches(w, from: number, to: number): boolean
	local beam = beams.beamFor(w, from, to)
	return beam ~= nil and approach.gap(w, from, to) <= w:get(beam, "Beam").radius
end

-- Переносит лучом до amount груза со склада from на склад to (transfer); возвращает перенесённое.
function beams.transfer(w, from: number, to: number, good: string, amount: number?): number
	local carrier = beams.beamFor(w, from, to)
	if not carrier then
		return 0
	end
	local beam = w:get(carrier, "Beam")
	if approach.gap(w, from, to) > beam.radius then
		return 0
	end
	local source, target = w:get(from, "Inventory"), w:get(to, "Inventory")
	local moved = math.min(amount or math.huge, beam.rate * w.dt, goods.amount(source, good), goods.room(target, good))
	if moved <= 0 then
		return 0
	end
	local partner = if carrier == from then to else from
	local pulling = carrier == to
	local known = false
	for _, link in beam.links do
		if link.target == partner and link.pulling == pulling then
			known = true
		end
	end
	if not known then
		table.insert(beam.links, { target = partner, pulling = pulling, resource = good })
	end
	goods.put(target, good, goods.take(source, good, moved))
	return moved
end

return beams
