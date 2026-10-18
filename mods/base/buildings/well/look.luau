--!strict
-- Колодец подземной трубы, 1×1: люк в бетонном кольце, по нему труба уходит под землю.

local b = require("lib/buildings")

local STEEL, IRON, INK = b.STEEL, b.IRON, b.INK
local band = bit32.band

return b.look(1, 1, function(g, t: number, _working: boolean, connections: number)
	local sides = {}
	if band(connections, b.NORTH) ~= 0 then
		table.insert(sides, { 5, 0, 6, 4 })
	end
	if band(connections, b.SOUTH) ~= 0 then
		table.insert(sides, { 5, 12, 6, 4 })
	end
	if band(connections, b.WEST) ~= 0 then
		table.insert(sides, { 0, 5, 4, 6 })
	end
	if band(connections, b.EAST) ~= 0 then
		table.insert(sides, { 12, 5, 4, 6 })
	end
	for _, side in sides do
		local x, y, w, h = side[1], side[2], side[3], side[4]
		g:rect(x, y, w, h, INK)
		g:rect(x + 1, y + 1, math.max(1, w - 2), math.max(1, h - 2), IRON[2])
	end
	g:circle(8, 8, 6, INK)
	g:circle(8, 8, 5, STEEL[2])
	g:ring(8, 8, 4, 1, STEEL[0])
	g:circle(8, 8, 3, IRON[1])
	g:rect(6, 7, 4, 1, IRON[3])
	g:rect(6, 9, 4, 1, IRON[3])
	b.bulb(g, 12, 3, b.pulse(t))
end, { variants = 16 })
