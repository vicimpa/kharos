--!strict
-- Стена, 1×1 — перенос wall из buildingArt.ts: центральная опора и рукава до соседних секций; вариант — биты соседей.

local b = require("lib/buildings")

local STEEL, IRON, RUST, INK = b.STEEL, b.IRON, b.RUST, b.INK
local band = bit32.band

return b.look(1, 1, function(g, _t: number, _working: boolean, connections: number)
	local north = band(connections, b.NORTH) ~= 0
	local east = band(connections, b.EAST) ~= 0
	local south = band(connections, b.SOUTH) ~= 0
	local west = band(connections, b.WEST) ~= 0

	-- Рукава доходят до края тайла только со стороны соседа: две секции встречаются без прозрачного шва.
	if east or west then
		local left = if west then 0 else 3
		local right = if east then 16 else 13
		g:rect(left, 4, right - left, 9, INK)
		g:rect(left, 5, right - left, 6, STEEL[1])
		g:rect(left, 5, right - left, 1, STEEL[3])
		g:rect(left, 11, right - left, 1, STEEL[0])
	end
	if north or south then
		local top = if north then 0 else 3
		local bottom = if south then 16 else 13
		g:rect(4, top, 9, bottom - top, INK)
		g:rect(5, top, 6, bottom - top, STEEL[1])
		g:rect(5, top, 1, bottom - top, STEEL[3])
		g:rect(11, top, 1, bottom - top, STEEL[0])
	end

	-- Центральная опора скрывает наложение рукавов и остаётся у одиночной секции.
	g:rect(3, 3, 10, 10, INK)
	g:rect(4, 4, 8, 8, IRON[1])
	g:rect(4, 4, 8, 1, IRON[3])
	g:rect(4, 11, 8, 1, IRON[0])
	g:rect(4, 5, 1, 6, IRON[2])
	g:rect(11, 5, 1, 6, IRON[0])
	for _, at in { { 5, 5 }, { 10, 5 }, { 5, 10 }, { 10, 10 } } do
		g:rect(at[1], at[2], 1, 1, RUST[1])
	end
end, { variants = 16 })
