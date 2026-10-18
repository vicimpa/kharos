--!strict
-- Поток в трубах — перенос flowPass.ts: что идёт по трубам — бегущие метки цвета груза. Пачка известна целиком с
-- отправки (путь узлами, тики отправки и прихода), так что метка едет сама. На подземном отрезке между колодцами и над
-- зданиями её не видно — только на трубе. Подземные отрезки своих колодцев — пунктир от колодца до парного, у колодца без
-- пары — красный крестик.

local kinds = require("lib/kinds")

local flow = {}

flow.data = {
	-- Сторона метки пачки в тайлах и толщина её тёмной обводки (MARK, OUTLINE).
	mark = 0.3,
	outline = 0.08,
}

local INK = 0x0a0d14
local DASH = 0x2063a0
local UNPAIRED = 0xcf2e24

-- Толщина в тайлах — пикселями экрана.
local function pixels(c, tiles: number): number
	return math.max(1, tiles * c.camera.zoom)
end

function flow.update(c)
	local d = flow.data
	local now = c.tick + c.alpha
	for _, e in c:each({ "Batch", "Owner" }) do
		if not c:mine(e) then
			continue
		end
		local batch = c:get(e, "Batch")
		local share = (now - batch.sent) / math.max(1, batch.arrive - batch.sent)
		if share < 0 or share > 1 then
			continue
		end
		local points = {}
		local known = true
		for _, node in batch.path do
			local at = c:alive(node) and c:get(node, "Position")
			if not at then
				known = false
				break
			end
			local kind = kinds.of(c, node)
			table.insert(points, { x = at.x, y = at.y, well = kind ~= nil and kind.name == "well" })
		end
		if not known or #points < 2 then
			continue
		end
		-- Длина пути по отрезкам: метка едет с одной скоростью по всей ломаной.
		local total = 0
		for i = 2, #points do
			total += math.sqrt((points[i].x - points[i - 1].x) ^ 2 + (points[i].y - points[i - 1].y) ^ 2)
		end
		local left = share * total
		for i = 2, #points do
			local from, to = points[i - 1], points[i]
			local length = math.sqrt((to.x - from.x) ^ 2 + (to.y - from.y) ^ 2)
			if left > length and i < #points then
				left -= length
				continue
			end
			-- Под землёй — между двумя колодцами, не соседними, — пачки не видно.
			if from.well and to.well and length > 1 then
				break
			end
			local part = if length > 0 then math.min(1, left / length) else 1
			local x, y = from.x + (to.x - from.x) * part, from.y + (to.y - from.y) * part
			-- Груз видно только на трубе.
			local under = c:occupant(x, y)
			local kind = under and kinds.of(c, under)
			if not kind or not kind.data.pipe then
				break
			end
			local good = c.protos.goods[batch.resource]
			local outer = d.mark + d.outline * 2
			c.draw:line(x - outer / 2, y, x + outer / 2, y, INK, pixels(c, outer))
			c.draw:line(x - d.mark / 2, y, x + d.mark / 2, y, if good then good.data.color else 0xffffff, pixels(c, d.mark))
			break
		end
	end

	-- Подземные отрезки своих колодцев: пунктир по графу сети; колодец без пары — красный крестик.
	local paired = {}
	for _, network in c:networks() do
		if network.player ~= c.player then
			continue
		end
		local edges = network.edges
		for i = 1, #edges, 3 do
			local a, b = edges[i], edges[i + 1]
			local one, two = kinds.of(c, a), kinds.of(c, b)
			if not one or not two or one.name ~= "well" or two.name ~= "well" then
				continue
			end
			paired[a], paired[b] = true, true
			local p, q = c:get(a, "Position"), c:get(b, "Position")
			local length = math.sqrt((q.x - p.x) ^ 2 + (q.y - p.y) ^ 2)
			local step = 0.75
			while step < length - 0.5 do
				local from, to = step / length, math.min(step + 0.5, length - 0.5) / length
				c.draw:line(p.x + (q.x - p.x) * from, p.y + (q.y - p.y) * from, p.x + (q.x - p.x) * to, p.y + (q.y - p.y) * to, DASH, pixels(c, 0.12), 0.7)
				step += 1
			end
		end
	end
	for _, e in c:each({ "Building", "Position", "Owner" }) do
		local kind = kinds.of(c, e)
		if kind and kind.name == "well" and c:mine(e) and not paired[e] and not c:has(e, "Site") then
			local at = c:get(e, "Position")
			c.draw:line(at.x - 0.3, at.y - 0.3, at.x + 0.3, at.y + 0.3, UNPAIRED, pixels(c, 0.12), 0.9)
			c.draw:line(at.x - 0.3, at.y + 0.3, at.x + 0.3, at.y - 0.3, UNPAIRED, pixels(c, 0.12), 0.9)
		end
	end
end

return flow
