--!strict
-- Месторождения на панели: в сведениях шахты — какая руда под ней и сколько осталось; у указателя над картой — какое
-- месторождение, сколько осталось и что из него выйдет.

local construction = require("lib/construction")
local depositsLib = require("lib/deposits")
local goods = require("lib/goods")
local logistics = require("lib/logistics")
local panel = require("lib/panel")
local widgets = require("lib/widgets")

local function info(c, view)
	if not (view.built and view.kind.data.extract) then
		return
	end
	local ui = c.ui
	local deposit = logistics.depositUnder(c, view.first)
	local depositKind = deposit and c:proto(deposit)
	local ore = depositKind and c.protos.goods[goods.oreOf(c, depositKind.name) or ""]
	if deposit and ore then
		local left = c:get(deposit, "Deposit").reserve
		ui:box({ direction = "row", align = "center", gap = 6, width = view.width }, function()
			panel.goodWith(c, ore.name, nil, 20)
			local line = c:t("hud.depositLeft", { name = c:t(ore.data.title), left = if left > 0 then c:t("hud.left", { amount = math.floor(left) }) else c:t("hud.depositDepleted") })
			local _, after = widgets.split(line, "icon")
			ui:text((string.gsub(after, "^%s+", "")), { color = widgets.COLORS.soft })
		end)
	end
end

-- Остаток, каким игрок видел месторождение в последний раз: пока видит хоть тайл — настоящий, в тумане — прежний; так
-- туман не выдаёт, копают ли его чужие. Ключ — сущность месторождения.
local seenReserve: { [number]: number } = {}

local function knownReserve(c, e: number, x: number, y: number): number?
	for dy = 0, depositsLib.SIZE - 1 do
		for dx = 0, depositsLib.SIZE - 1 do
			if c:sees(x + dx + 0.5, y + dy + 0.5) then
				local left = c:get(e, "Deposit").reserve
				seenReserve[e] = left
				return left
			end
		end
	end
	return seenReserve[e]
end

-- Что выйдет из месторождения и через что: «Металлическая руда → Плавильня → Металл».
local function chainOf(c, resource: string): string
	local ore = goods.oreOf(c, resource)
	local refinery = "?"
	for _, kind in construction.menu(c) do
		if ore and kind.data.refines == ore then
			refinery = c:t(kind.data.title)
			break
		end
	end
	local function title(name: string?): string
		local kind = name and c.protos.goods[name]
		return if kind then c:t(kind.data.title) else "?"
	end
	return title(ore) .. " → " .. refinery .. " → " .. title(resource)
end

local function hover(c, view)
	local tileX, tileY, anchor = panel.hover(c, view)
	if not tileX then
		return
	end
	local ui = c.ui
	-- Месторождение занимает SIZE × SIZE тайлов: подходит то, что накрывает тайл под указателем.
	local half = depositsLib.SIZE / 2
	for _, e in c:each({ "Deposit", "Position" }) do
		local at = c:get(e, "Position")
		local x, y = at.x - half, at.y - half
		if tileX >= x and tileX < x + depositsLib.SIZE and tileY >= y and tileY < y + depositsLib.SIZE and c:knows(e) then
			view.tip = true
			local kind = c:proto(e)
			local resource = kind and kind.name
			local good = resource and c.protos.goods[resource]
			if not good then
				return
			end
			local left = knownReserve(c, e, x, y)
			ui:box({ anchor = anchor, skin = "panel", padding = { 8, 12 }, direction = "column", gap = 2, passive = true }, function()
				ui:box({ direction = "row", align = "center", gap = 6 }, function()
					ui:image(good, 20, 20)
					ui:text(c:t("hud.depositTip", { name = c:t(good.data.title) }))
					ui:text(if left == nil then c:t("hud.leftUnknown") elseif left > 0 then c:t("hud.left", { amount = math.floor(left) }) else c:t("hud.depleted"), { color = widgets.COLORS.dim })
				end)
				ui:text(chainOf(c, resource), { color = widgets.COLORS.dim, wrap = 300 })
			end)
			return
		end
	end
end

return {
	info = { { at = 160, draw = info } },
	overlay = { { at = 60, draw = hover } },
}
