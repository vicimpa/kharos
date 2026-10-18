--!strict
-- Наземная труба, 1×1: рукава к соседям по сторонам (трубам и зданиям сети), биты — как у стены. Одиночная — короткий
-- обрубок с фланцами.

local b = require("lib/buildings")

local IRON, RUST, INK = b.IRON, b.RUST, b.INK
local band = bit32.band

return b.look(1, 1, function(g, _t: number, _working: boolean, connections: number)
	local north = band(connections, b.NORTH) ~= 0
	local east = band(connections, b.EAST) ~= 0
	local south = band(connections, b.SOUTH) ~= 0
	local west = band(connections, b.WEST) ~= 0
	local lone = connections == 0
	if east or west or lone then
		local left = if west then 0 else 4
		local right = if east then 16 else 12
		g:rect(left, 5, right - left, 6, INK)
		g:rect(left, 6, right - left, 4, IRON[2])
		g:rect(left, 6, right - left, 1, IRON[4])
		g:rect(left, 9, right - left, 1, IRON[0])
	end
	if north or south then
		local top = if north then 0 else 4
		local bottom = if south then 16 else 12
		g:rect(5, top, 6, bottom - top, INK)
		g:rect(6, top, 4, bottom - top, IRON[2])
		g:rect(6, top, 1, bottom - top, IRON[4])
		g:rect(9, top, 1, bottom - top, IRON[0])
	end
	-- Фланец на стыке: у поворотов и развилок он закрывает наложение рукавов.
	if (north or south) and (east or west) then
		g:rect(4, 4, 8, 8, INK)
		g:rect(5, 5, 6, 6, IRON[1])
		g:rect(5, 5, 6, 1, IRON[3])
		g:rect(7, 7, 2, 2, RUST[1])
	end
end, { variants = 16 })
