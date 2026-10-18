--!strict
-- Сдача и уничтожение своих. Гибнет обречённое (Doomed) в бою движка (crates/world/src/combat.rs) обычной гибелью:
-- взрыв, остов, событие killed. Проиграл ли игрок — lib/defeat.

local conversion = require("lib/conversion")
local defeat = require("lib/defeat")
local wallet = require("lib/wallet")
local drops = require("lib/drops")

local mechanic = {}

-- Кусок панели игрока (ui/hud).
mechanic.panel = require("./panel")

mechanic.data = {
	-- За сколько секунд волна взрывов при сдаче доходит от главного здания на тайл дальше; первый взрыв — не сразу:
	-- игрок успевает понять, что произошло; разброс взрывов одной волны, в секундах.
	wave = 0.12,
	delay = 0.6,
	jitter = 0.5,
}

-- Кредиты игрока — в ноль.
local function bankrupt(ctx, player: number)
	local entity = wallet.of(ctx, player)
	if entity then
		ctx:set(entity, "Player", { credits = 0, earned = 0 })
	end
end

-- Игрок сдаётся — харакири (surrender): все его юниты и здания взрываются волной от главного здания (или от середины
-- его войска) наружу, каждое — обычной гибелью, и груз со складов падает на землю (mechanics/drops). Стройки исчезают
-- сразу, привезённое на них остаётся на земле. Кредиты — в ноль.
local function surrender(ctx, player: number)
	local d = mechanic.data
	local core = conversion.building(ctx)
	local doomed, sites = {}, {}
	local sumX, sumY = 0, 0
	local centerX, centerY = nil :: number?, nil :: number?
	for _, e in ctx:each({ "Owner", "Position" }) do
		if ctx:get(e, "Owner").player ~= player or ctx:has(e, "Attached") or ctx:has(e, "Doomed") then
			continue
		end
		-- Стройка — ещё не здание; разбираемое готовое — здание.
		local site = ctx:get(e, "Site")
		if site and not (site.demolish and not site.undo) then
			table.insert(sites, e)
			continue
		end
		if not ctx:has(e, "Unit") and not ctx:has(e, "Building") then
			continue
		end
		table.insert(doomed, e)
		local at = ctx:get(e, "Position")
		sumX += at.x
		sumY += at.y
		if centerX == nil and ctx:has(e, "Building") then
			local proto = ctx:get(e, "Proto")
			if proto and core and proto.id == core.id then
				centerX, centerY = at.x, at.y
			end
		end
	end
	for _, e in sites do
		drops.cargo(ctx, e)
		ctx:destroy(e)
	end
	bankrupt(ctx, player)
	if #doomed == 0 then
		return
	end
	local x: number = centerX or sumX / #doomed
	local y: number = centerY or sumY / #doomed
	for _, e in doomed do
		local at = ctx:get(e, "Position")
		local jitter = ((e * 2654435761) % 1000) / 1000
		local seconds = d.delay + math.sqrt((at.x - x) ^ 2 + (at.y - y) ^ 2) * d.wave + jitter * d.jitter
		ctx:add(e, "Doomed", { left = math.max(1, math.floor(seconds / ctx.dt + 0.5)) })
	end
end

mechanic.commands = {
	-- {} — сдаться.
	surrender = function(ctx, player, _args)
		surrender(ctx, player)
	end,
	-- { units } — уничтожить своих юнитов (scuttle): в ближайшем бою они гибнут обычной гибелью — взрыв, остов. Урона
	-- вокруг нет, цена не возвращается. Турель на носителе отдельно не уничтожить.
	scuttle = function(ctx, player, args)
		for _, e in defeat.giftable(ctx, player, args.units) do
			ctx:add(e, "Doomed", { left = 1, scuttled = true })
		end
	end,
}

return mechanic
