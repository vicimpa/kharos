--!strict
-- Облик по соседям: стена и ворота соединяются со стенами и воротами рядом, труба и колодец — со всем, что входит в
-- сеть (кроме стен), и с площадками труб. Вариант — биты соседей севера, востока, юга и запада, у опущенных ворот — ещё
-- GATE_OPEN; и готовая стена, и ещё не начатая соседняя площадка участвуют в соединении: чертёж сразу показывает итог.

local buildings = require("lib/buildings")
local kinds = require("lib/kinds")
local placement = require("lib/placement")

local connections = {}

local SIDES = { { 0, -1, buildings.NORTH }, { 1, 0, buildings.EAST }, { 0, 1, buildings.SOUTH }, { -1, 0, buildings.WEST } }

function connections.update(c)
	local walls, pipes = {}, {}
	local list = {}
	for _, e in c:each({ "Building", "Position" }) do
		local kind = kinds.of(c, e)
		if not kind then
			continue
		end
		local name = kind.name
		if name == "wall" or name == "gate" or kind.data.pipe then
			local at = c:get(e, "Position")
			local size = c:get(e, "Building")
			local x, y = placement.left(at.x, size.width), placement.left(at.y, size.height)
			local key = x .. ":" .. y
			if name == "wall" or name == "gate" then
				walls[key] = true
			elseif c:has(e, "Site") then
				pipes[key] = true
			end
			-- Опущенная плита ворот — свой вид; соседи у ворот те же, что у стены.
			local footprint = name == "gate" and not c:has(e, "Site") and c:get(e, "Footprint")
			local open = footprint and footprint.passable or false
			table.insert(list, { e = e, x = x, y = y, wall = name == "wall" or name == "gate", open = open })
		end
	end
	if #list == 0 then
		return
	end
	-- Труба соединяется со всем, что у неё сбоку и входит в сеть: с трубами и зданиями, кроме стен, и с площадками труб.
	local function joins(x: number, y: number): boolean
		if pipes[x .. ":" .. y] then
			return true
		end
		local other = c:occupant(x, y)
		local kind = other and kinds.of(c, other)
		return kind ~= nil and not kind.data.isolated
	end
	for _, item in list do
		local variant = if item.open then buildings.GATE_OPEN else 0
		for _, side in SIDES do
			local x, y = item.x + side[1], item.y + side[2]
			if if item.wall then walls[x .. ":" .. y] else joins(x, y) then
				variant += side[3]
			end
		end
		c:dress(item.e, { variant = variant })
	end
end

return connections
