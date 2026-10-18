--!strict
-- Энергия на экране — перенос из buildingsPass.ts и powerPass.ts: электростанция под нагрузкой работает (огни бегут,
-- по трубам идёт топливо), лишняя стоит в запасе; своё выключенное стоит темнее, без огней и со значком; над
-- потребителями, которым не хватает энергии, мигает молния на красном круге, по перегруженным станциям бьют молнии; над
-- повреждёнными зданиями — полоска прочности; над своими зданиями, к которым не подъехать грузовикам, — «въезд запрещён».

local economy = require("lib/economy")
local noise = require("lib/noise").of

local power = {}

local function rgb(r: number, g: number, b: number): number
	return math.round(r * 255) * 0x10000 + math.round(g * 255) * 0x100 + math.round(b * 255)
end

power.data = {
	-- Раз во сколько секунд пересчитывается, какие станции под нагрузкой: это обход всех сетей (PLANTS_EVERY).
	plantsEvery = 0.5,
	-- Молнии: сколько разных, сколько раз в секунду меняются, какую долю кадров видны и насколько выше основания бьют,
	-- в тайлах (BOLTS, BOLT_RATE, BOLT_SHOWN, BOLT_RISE).
	bolts = 6,
	boltRate = 14,
	boltShown = 0.6,
	boltRise = 0.5,
	-- Значок: сторона в тайлах, цикл мигания в секундах и доля цикла, когда виден (ICON_TILES, ICON_PERIOD, ICON_SHOWN).
	icon = 0.75,
	iconPeriod = 1,
	iconShown = 0.7,
	-- Полоса прочности: высота и промежуток в пикселях экрана, отступ над крышей в тайлах (STATUS_BAR, STATUS_STACK,
	-- STATUS_GAP).
	bar = 3,
	stack = 1,
	gap = 0.1,
}

local BAR_BACK = rgb(0.03, 0.05, 0.08)
local BAR_GOOD = rgb(0.45, 0.9, 0.55)
local BAR_BAD = rgb(1, 0.35, 0.25)

-- Станции под нагрузкой и когда их считали.
local plants: { [number]: boolean } = {}
local plantsAt = -math.huge

function power.update(c)
	local d = power.data
	local time = c.time
	if math.abs(time - plantsAt) >= d.plantsEvery then
		plants = economy.loadedPlants(c)
		plantsAt = time
	end
	local states = economy.states(c)
	local bolt, alarm = c.protos.sprites.bolt, c.protos.sprites.alarm
	local zoom = c.camera.zoom
	local step = math.floor(time * d.boltRate)
	local iconOn = (time % d.iconPeriod) / d.iconPeriod < d.iconShown
	local barHeight = d.bar / zoom
	local x1, y1 = c:to_world(0, 0)
	local x2, y2 = c:to_world(c.screen.w, c.screen.h)
	for _, e in c:each({ "Building", "Position" }) do
		local size = c:get(e, "Building")
		local at = c:get(e, "Position")
		local left, top = at.x - size.width / 2, at.y - size.height / 2
		if left + size.width < x1 - 2 or left > x2 + 2 or top + size.height < y1 - 2 or top > y2 + 2 then
			continue
		end
		local site = c:get(e, "Site")
		local off = economy.shutDown(c, c.player, e)
		if off then
			c:dress(e, { off = true })
		elseif plants[e] and not site then
			c:dress(e, { working = true })
		end
		-- По чужому вне обзора не видно, что с ним.
		if not c:mine(e) and not c:sees(at.x, at.y) then
			continue
		end
		local state = states[e]
		if state == "overload" and noise(step, e) < d.boltShown then
			-- Каждая вторая молния отражена, чтобы шести картинок хватало надолго.
			local frame = math.floor(noise(e, step) * d.bolts)
			c.draw:stretch(bolt, frame, left, top - d.boltRise, size.width, size.height + d.boltRise, noise(step + 7, e) < 0.5)
		end
		-- Полоса прочности над крышей — у повреждённого, кроме строящегося (там она равна полосе стройки).
		local health = c:get(e, "Health")
		local rows = 0
		if health and health.value < health.max and not (site and (not site.demolish or site.undo)) then
			rows = 1
			local share = math.max(0, health.value / health.max)
			local barTop = top - d.gap - barHeight / 2
			c.draw:line(left, barTop, left + size.width, barTop, BAR_BACK, d.bar)
			c.draw:line(left, barTop, left + size.width * share, barTop, if share > 0.5 then BAR_GOOD else BAR_BAD, d.bar)
		end
		-- Значки — над полосами, несколько сразу — рядом. Тревожные мигают и держат место, «Выключено» горит ровно.
		local icons = {}
		local mark = c:get(e, "Unreachable")
		if mark and mark["until"] > c.tick and c:mine(e) then
			table.insert(icons, { 2, iconOn })
		end
		if state == "starved" then
			table.insert(icons, { 0, iconOn })
		end
		if off then
			table.insert(icons, { 1, true })
		end
		local lifted = top - (if rows > 0 then d.gap + rows * (d.bar + d.stack) / zoom else 0)
		for i, icon in icons do
			if icon[2] then
				local x = left + size.width / 2 + (i - 1 - #icons / 2) * d.icon + d.icon / 2
				c.draw:sprite(alarm, icon[1], x, lifted, d.icon)
			end
		end
	end
end

return power
