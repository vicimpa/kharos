--!strict
-- Остов погибшей техники: юнит, нарисованный как обычно, обгорает до угля с ржавчиной и копотью, а края его обломаны;
-- турели лежат на своих местах, повёрнутые как попало. Шестнадцать направлений, фаза — вид юнита по порядку data.names:
-- все юниты с чертежом (look.paint), и из других модов тоже — их собирает collect из patch мода (mod.luau).

local units = require("lib/units")
local noise = require("lib/noise").of

local DIRECTIONS = 16
local VARIANTS = 3

local wreck = {}

wreck.data = { names = {} :: { string } }

-- Все виды по разделам: их даёт collect.
local protos: any = nil

-- Байт канала: дробная часть отбрасывается.
local function byte(value: number): number
	return math.floor(value) % 256
end

local function draw(g, angle: number, phase: number)
	local unit = protos.units[wreck.data.names[phase + 1]]
	local direction = math.round(angle / (math.pi * 2) * DIRECTIONS) % DIRECTIONS
	local variant = direction % VARIANTS
	unit.look.paint(g, angle, units.TEAMS.foe, 0)
	for i, mount in unit.data.mounts or {} do
		local turret = protos.turrets[mount.turret]
		if not turret or not turret.look or not turret.look.paint or turret.look.wreck == false then
			continue
		end
		local x = (math.cos(angle) * mount.along - math.sin(angle) * mount.across) * 16
		local y = (math.sin(angle) * mount.along + math.cos(angle) * mount.across) * 16
		g:translate(x, y)
		turret.look.paint(g, angle + (noise(i - 1, variant, 9) - 0.5) * 2.5, units.TEAMS.foe)
		g:translate(-x, -y)
	end
	local width, height = g.width, g.height
	local function solid(x: number, y: number): boolean
		return g:get(x, y) ~= 0
	end
	local edge = {}
	for y = 0, height - 1 do
		for x = 0, width - 1 do
			edge[y * width + x] = solid(x, y) and (not solid(x - 1, y) or not solid(x + 1, y) or not solid(x, y - 1) or not solid(x, y + 1))
		end
	end
	for y = 0, height - 1 do
		for x = 0, width - 1 do
			local color = g:get(x, y)
			if color == 0 then
				continue
			end
			local grain = noise(x, y, variant * 31 + direction)
			if edge[y * width + x] and grain < 0.25 then
				g:set(x, y, 0)
				continue
			end
			-- Светлое обгорает до серого угля, тёмное — до чёрного; кое-где ржавчина и копоть.
			local r, gr, b = bit32.band(bit32.rshift(color, 16), 0xff), bit32.band(bit32.rshift(color, 8), 0xff), bit32.band(color, 0xff)
			local light = (r + gr + b) / (3 * 255)
			r, gr, b = 0x22 + light * 0x58, 0x1e + light * 0x4c, 0x1a + light * 0x40
			-- Пятна ржавчины и копоти — крупные, по три пикселя: мелкая рябь съела бы силуэт.
			local spot = noise(x // 3, y // 3, variant + direction * 7)
			if spot > 0.9 then
				r, gr, b = 0x6a, 0x3c, 0x22
			elseif spot < 0.1 then
				r, gr, b = 0x10, 0x0d, 0x0b
			end
			g:set(x, y, byte(r) * 0x10000 + byte(gr) * 0x100 + byte(b))
		end
	end
end

wreck.look = { size = units.FRAME, directions = DIRECTIONS, phases = 1, draw = draw }

-- Остовы юнитов всех модов: имена по алфавиту, кадров — по юниту.
function wreck.collect(all)
	protos = all
	local names = {}
	for name, unit in all.units or {} do
		if type(unit) == "table" and unit.look and unit.look.paint then
			table.insert(names, name)
		end
	end
	table.sort(names)
	wreck.data.names = names
	wreck.look.phases = math.max(1, #names)
end

return wreck
