--!strict
-- Энергия на экране: электростанция под нагрузкой работает (огни бегут, по трубам идёт топливо), лишняя стоит в запасе;
-- своё выключенное стоит темнее, без огней и со значком; над потребителями, которым не хватает энергии, мигает молния
-- на красном круге, по перегруженным станциям бьют молнии; над повреждёнными зданиями — полоска прочности, над
-- генератором щита — запас; над своими зданиями и стройками, которые стоят без груза или кредитов, — значок груза
-- (lib/lacks), у турелей и реакторов на исходе — он же бледный; над своими зданиями, к которым не подъехать грузовикам,
-- — «въезд запрещён»; над своими юнитами с пустым магазином — значок боеприпасов.

local economy = require("lib/economy")
local lacks = require("lib/lacks")
local supply = require("lib/supply")
local noise = require("lib/noise").of
local rgb = require("lib/color").rgb

local power = {}

power.data = {
	-- Раз во сколько секунд пересчитывается, какие станции под нагрузкой: это обход всех сетей.
	plantsEvery = 0.5,
	-- Молнии: сколько разных, сколько раз в секунду меняются, какую долю кадров видны и насколько выше основания бьют,
	-- в тайлах.
	bolts = 6,
	boltRate = 14,
	boltShown = 0.6,
	boltRise = 0.5,
	-- Значок: сторона в тайлах, цикл мигания в секундах и доля цикла, когда виден.
	icon = 0.75,
	iconPeriod = 1,
	iconShown = 0.7,
	-- Значок над юнитом: насколько выше его края, в тайлах; запас на исходе — бледный значок такой непрозрачности, с
	-- какой доли магазина (LOW_SHARE = AMMO_REORDER).
	unitGap = 0.45,
	-- Раз во сколько тиков пересчитывается, каким своим зданиям чего не хватает.
	lackTicks = 10,
	lowAlpha = 0.5,
	lowShare = 0.25,
	-- Полоса прочности: высота и промежуток в пикселях экрана, отступ над крышей в тайлах.
	bar = 3,
	stack = 1,
	gap = 0.1,
}

local BAR_BACK = rgb(0.03, 0.05, 0.08)
local BAR_GOOD = rgb(0.45, 0.9, 0.55)
local BAR_BAD = rgb(1, 0.35, 0.25)
local BAR_SHIELD = rgb(0.3, 0.55, 1)

-- Чего ждут свои здания, у каких запас на исходе и в каком тике это считали.
local lacking: { [number]: string } = {}
local low: { [number]: string } = {}
local lacksAt = -math.huge

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
	-- Чего ждут свои здания: обход складов и сетей — раз в lackTicks тиков, а не каждый кадр.
	if math.abs(c.tick - lacksAt) >= d.lackTicks then
		lacking = lacks.of(c, c.player)
		low = lacks.low(c, c.player)
		lacksAt = c.tick
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
		else
			-- Электростанция под нагрузкой, горящий реактор и лаборатория, которая ведёт тему, — работают.
			local lab = c:get(e, "Research")
			if (plants[e] or economy.burning(c, e) or (lab ~= nil and lab.speed > 0)) and not site and not c:has(e, "Converting") then
				c:dress(e, { working = true })
			end
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
		-- Полосы над крышей, сверху вниз: прочность — у повреждённого, кроме строящегося (там она равна полосе
		-- стройки), под ней запас щита — у готового генератора щита.
		local health = c:get(e, "Health")
		local bars = {}
		if health and health.value < health.max and not (site and (not site.demolish or site.undo)) then
			local share = math.max(0, health.value / health.max)
			table.insert(bars, { share, if share > 0.5 then BAR_GOOD else BAR_BAD })
		end
		local shield = not site and c:get(e, "Shield")
		local kind = shield and c:proto(e)
		local dome = kind and kind.data.shield
		if shield and dome then
			table.insert(bars, { math.clamp(shield.charge / dome.capacity, 0, 1), BAR_SHIELD })
		end
		local rows = #bars
		local stack = d.stack / zoom
		for i, bar in bars do
			local barTop = top - d.gap - (rows - i + 1) * barHeight - (rows - i) * stack + barHeight / 2
			c.draw:line(left, barTop, left + size.width, barTop, BAR_BACK, d.bar)
			c.draw:line(left, barTop, left + size.width * bar[1], barTop, bar[2], d.bar)
		end
		-- Значки — над полосами, несколько сразу — рядом. Тревожные мигают и держат место, «Выключено» горит ровно;
		-- запас турели или реактора на исходе — бледный значок груза.
		local icons = {}
		local mark = c:get(e, "Unreachable")
		if mark and mark["until"] > c.tick and c:mine(e) then
			table.insert(icons, { phase = 2, shown = iconOn })
		end
		if state == "starved" then
			table.insert(icons, { phase = 0, shown = iconOn })
		end
		local lack = lacking[e]
		if lack == "credits" then
			table.insert(icons, { phase = alarm.data.broke, shown = iconOn })
		elseif lack then
			table.insert(icons, { good = c.protos.goods[lack], shown = iconOn })
		end
		local short = low[e]
		if short and not lack then
			table.insert(icons, { good = c.protos.goods[short], shown = true, alpha = d.lowAlpha })
		end
		if off then
			table.insert(icons, { phase = 1, shown = true })
		end
		local lifted = top - (if rows > 0 then d.gap + rows * (d.bar + d.stack) / zoom else 0)
		for i, icon in icons do
			if icon.shown then
				local x = left + size.width / 2 + (i - 1 - #icons / 2) * d.icon + d.icon / 2
				if icon.good then
					power.lack(c, icon.good, x, lifted, icon.alpha or 1)
				else
					c.draw:sprite(alarm, icon.phase, x, lifted, d.icon)
				end
			end
		end
	end
	-- Свои юниты с пустым магазином — значок боеприпасов, как над турелью без них, на исходе — он же бледный. Магазин
	-- видит только хозяин.
	if supply.enabled(c) then
		local ammo = c.protos.goods.ammo
		for _, e in c:each({ "Magazine", "Unit", "Position" }) do
			if not c:mine(e) then
				continue
			end
			local kind = c:proto(e)
			local capacity = if kind then supply.magazineOf(kind) else 0
			if capacity == 0 then
				continue
			end
			local empty = supply.isEmpty(c, e)
			if if empty then not iconOn else supply.ammoOf(c, e) >= capacity * d.lowShare then
				continue
			end
			local at = c:get(e, "Position")
			if at.x < x1 - 2 or at.x > x2 + 2 or at.y < y1 - 2 or at.y > y2 + 2 then
				continue
			end
			local y = at.y - c:get(e, "Mover").radius - d.unitGap
			power.lack(c, ammo, at.x, y, if empty then 1 else d.lowAlpha)
		end
	end
end

-- Значок нехватки груза kind в (x, y) — тёмный круг в красном кольце и груз в нём, непрозрачностью alpha.
function power.lack(c, kind, x: number, y: number, alpha: number)
	local size = power.data.icon
	c.draw:sprite(c.protos.sprites.alarm, c.protos.sprites.alarm.data.lack, x, y, size, nil, alpha)
	c.draw:sprite(kind, 0, x, y, size * 10 / 16, nil, alpha)
end

return power
