--!strict
-- Груз на земле (dropsPass.ts): кучка ящиков цвета того груза, которого в ней больше всего; чем больше груза, тем больше
-- ящиков (sprites/crates). Над покрытием и под зданиями.

local drops = require("lib/drops")

local function update(c)
	local kind = c.protos.sprites.crates
	if not kind then
		return
	end
	local d = kind.data
	local zoom = c.camera.zoom
	local halfWidth, halfHeight = c.screen.w / 2 / zoom + 1, c.screen.h / 2 / zoom + 1
	for _, e in c:each({ "Drop", "Inventory", "Position" }) do
		local at = c:get(e, "Position")
		if math.abs(at.x - c.camera.x) > halfWidth or math.abs(at.y - c.camera.y) > halfHeight then
			continue
		end
		local main, load = drops.main(c, c:get(e, "Inventory"))
		local good = main and c.protos.goods[main]
		if load <= 0 or not good then
			continue
		end
		local count = math.min(d.crates, math.max(1, math.ceil(load / d.perCrate)))
		c:show(kind, at.x, at.y, { phase = count - 1 })
		local color = good.data.color or 0xffffff
		local r, g, b = bit32.band(bit32.rshift(color, 16), 255) / 255, bit32.band(bit32.rshift(color, 8), 255) / 255, bit32.band(color, 255) / 255
		c:show(kind, at.x, at.y, { phase = d.bands + count - 1, tint = { r, g, b, 1 } })
	end
end

return { update = update }
