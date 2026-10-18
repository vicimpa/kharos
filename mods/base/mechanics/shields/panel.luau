--!strict
-- Щит в сведениях: запас купола генератора или когда он поднимется.

local widgets = require("lib/widgets")

local function info(c, view)
	local dome = not view.many and view.built and view.kind.data.shield
	local shield = dome and c:get(view.first, "Shield")
	if shield then
		local down = math.max(0, math.ceil((shield.down - c.tick) * c.step))
		c.ui:text(if down > 0 then c:t("hud.shieldDown", { seconds = down }) else c:t("hud.shield", { charge = math.floor(shield.charge), capacity = dome.capacity }), { color = widgets.COLORS.soft, wrap = view.width })
	end
end

return {
	info = { { at = 90, draw = info } },
}
