--!strict
-- Укрепление перед главным зданием — перенос fortify.ts: случайная схема обороны (стена, турели) в своих осях: u — от
-- главного здания к врагу, v — поперёк фронта. Главное здание — в начале осей, занимает |u|, |v| ≤ 1. Схема
-- поворачивается к нужной стороне уже при постановке. На ней стоит сценка витрины «оборона» (scenes/defense).

local fortify = {}

-- Наборы турелей: оборона то ровная, то с упором в пулемёты, ракеты или пушки (MIXES).
local MIXES = {
	{ { "turret", 1 }, { "rocketTurret", 1 }, { "cannonTurret", 1 } },
	{ { "turret", 3 }, { "rocketTurret", 1 } },
	{ { "rocketTurret", 3 }, { "cannonTurret", 1 } },
	{ { "cannonTurret", 2 }, { "turret", 1 } },
	{ { "turret", 1 }, { "cannonTurret", 1 } },
}

local function between(random: () -> number, min: number, max: number): number
	return min + math.floor(random() * (max - min + 1))
end

local function picker(random: () -> number, mix): () -> string
	local total = 0
	for _, entry in mix do
		total += entry[2]
	end
	return function()
		local roll = random() * total
		for _, entry in mix do
			roll -= entry[2]
			if roll < 0 then
				return entry[1]
			end
		end
		return mix[1][1]
	end
end

type Piece = { type: string, u: number, v: number }

-- Прямая стена с одним-двумя проходами и ряд турелей за ней.
local function line(random, turret): { Piece }
	local pieces = {}
	local half = between(random, 6, 10)
	local front = between(random, 5, 7)
	local gates = if random() < 0.5 then { 0 } else { -math.ceil(half / 2), math.ceil(half / 2) }
	local gateWidth = between(random, 1, 2)
	for v = -half - 1, half + 1 do
		local open = false
		for _, gate in gates do
			open = open or math.abs(v - gate) < gateWidth
		end
		if not open then
			table.insert(pieces, { type = "wall", u = front + 2, v = v })
		end
	end
	local spacing = between(random, 2, 4)
	for v = -half + 1, half - 1, spacing do
		table.insert(pieces, { type = turret(), u = front, v = v })
	end
	return pieces
end

-- Дуга стены вокруг главного здания, со стороны врага, с воротами посередине; турели — внутренним кольцом.
local function arc(random, turret): { Piece }
	local pieces = {}
	local radius = between(random, 7, 10)
	local spread = 0.9 + random() * 0.6
	local seen = {}
	local function ring(r: number, step: number, place: (number, number, number) -> ())
		local angle = -spread
		while angle <= spread do
			local u, v = math.round(math.cos(angle) * r), math.round(math.sin(angle) * r)
			local key = u .. "," .. v
			if not seen[key] then
				seen[key] = true
				place(u, v, angle)
			end
			angle += step
		end
	end
	local gate = 1.2 / radius
	ring(radius, 0.5 / radius, function(u, v, angle)
		if math.abs(angle) > gate then
			table.insert(pieces, { type = "wall", u = u, v = v })
		end
	end)
	ring(radius - 2, between(random, 2, 3) / (radius - 2), function(u, v)
		table.insert(pieces, { type = turret(), u = u, v = v })
	end)
	return pieces
end

-- Бастионы: несколько гнёзд из пары-тройки турелей, прикрытых стеной спереди и с боков; между ними — открыто.
local function bastions(random, turret): { Piece }
	local pieces = {}
	local count = between(random, 2, 4)
	local gap = between(random, 8, 11)
	local front = between(random, 5, 8)
	for i = 0, count - 1 do
		local v0 = math.round((i - (count - 1) / 2) * gap)
		local guns = if random() < 0.5 then { -1, 0, 1 } else { 0, 1 }
		for _, dv in guns do
			table.insert(pieces, { type = turret(), u = front, v = v0 + dv })
		end
		local left, right = v0 + guns[1] - 1, v0 + guns[#guns] + 1
		for v = left, right do
			table.insert(pieces, { type = "wall", u = front + 1, v = v })
		end
		table.insert(pieces, { type = "wall", u = front, v = left })
		table.insert(pieces, { type = "wall", u = front, v = right })
		-- Иногда гнездо глубже: вторая линия турелей позади.
		if random() < 0.4 then
			table.insert(pieces, { type = turret(), u = front - 1, v = v0 })
		end
	end
	return pieces
end

-- Клин: стена углом к врагу, остриё — с воротами; турели вдоль обеих сторон клина.
local function wedge(random, turret): { Piece }
	local pieces = {}
	local tip = between(random, 9, 12)
	local half = between(random, 7, 10)
	local slope = 0.5 + random() * 0.5
	local spacing = between(random, 2, 3)
	for v = -half, half do
		local u = math.round(tip - math.abs(v) * slope)
		if math.abs(v) > 1 then
			table.insert(pieces, { type = "wall", u = u, v = v })
		end
		if math.abs(v) >= 2 and math.abs(v) % spacing == 0 then
			table.insert(pieces, { type = turret(), u = u - 2, v = v })
		end
	end
	return pieces
end

-- Две линии: дальняя — редкие турели без стены, ближняя — стена с турелями; прорвавшиеся упираются во вторую.
local function depth(random, turret): { Piece }
	local pieces = {}
	local half = between(random, 6, 8)
	local outer = between(random, 11, 13)
	local v = -half
	while v <= half do
		table.insert(pieces, { type = turret(), u = outer, v = v })
		v += between(random, 3, 5)
	end
	local inner = between(random, 5, 6)
	for w = -half, half do
		if math.abs(w) > 1 then
			table.insert(pieces, { type = "wall", u = inner + 1, v = w })
		end
	end
	for w = -half + 1, half - 1, 3 do
		table.insert(pieces, { type = turret(), u = inner - 1, v = w })
	end
	return pieces
end

fortify.LAYOUTS = { line, arc, bastions, wedge, depth }

-- Случайная оборона перед главным зданием (fortification): схема и набор турелей; каждая клетка — один раз, где схема
-- ставит две постройки в одно место, остаётся первая.
function fortify.of(random: () -> number): { Piece }
	local layout = fortify.LAYOUTS[math.floor(random() * #fortify.LAYOUTS) + 1]
	local pieces = layout(random, picker(random, MIXES[math.floor(random() * #MIXES) + 1]))
	local taken, kept = {}, {}
	for _, piece in pieces do
		local key = piece.u .. "," .. piece.v
		if not taken[key] and not (math.abs(piece.u) <= 2 and math.abs(piece.v) <= 2) then
			taken[key] = true
			table.insert(kept, piece)
		end
	end
	return kept
end

return fortify
