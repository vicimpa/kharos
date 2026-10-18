--!strict
-- Звук работы зданий. Каждый вид звука — одна петля, сколько бы ни звучало источников: громкость — по тому, сколько их
-- и насколько они близки к середине экрана, сторона — по тому, где они. Звучит только своё работающее: цех стучит, пока
-- движется его работа; горящий реактор, купол щита, шахта в пуске, MCV в превращении и ракеты — и чужие. Петли мира:
-- перегруженная станция трещит, стройка стучит, пока движется, ремонт шипит сваркой на цели, луч грузовика гудит, пока
-- переносит груз, турель зудит, пока поворачивается, накопитель пищит, пока через него идёт ток, груз в трубах булькает
-- там, докуда дотёк.

local economy = require("lib/economy")
local missiles = require("lib/missiles")

-- Доли срока пуска шахты: створки расходятся до DOORS, пар идёт с STEAM, двигатель ревёт с RISE.
local DOORS, STEAM, RISE = 0.35, 0.45, 0.6

local PERIOD = 0.2
local LEVELS = { hum = 0.22, machinery = 0.25, drill = 0.2, reactor = 0.3, dome = 0.06, hydraulic = 0.3, steam = 0.4, rocket = 0.6, flow = 0.12, overload = 0.4, construct = 0.28, weld = 0.16, tractor = 0.1, servo = 0.12, charge = 0.05 }
local SATURATE = 3
-- Петли мира набирают громкость быстрее.
local SATURATES = { reactor = 2, dome = 2, hydraulic = 2, steam = 2, rocket = 2, flow = 2, overload = 2, construct = 2, weld = 2, tractor = 2, servo = 2, charge = 2 }
-- Поворот турели меньше этого за проверку — не поворот.
local SERVO_MIN = 0.01
local WORK_HOLD = 0.6
local HEARING = 0.6

local since = PERIOD
local clock = 0
local activity = {}
-- Куда смотрела каждая турель при прошлой проверке.
local facings: { [number]: number } = {}

-- Работает ли здание: то, что в нём меняется, менялось не раньше WORK_HOLD секунд назад.
local function busy(entity: number, value: number): boolean
	local state = activity[entity] or { value = value, untilAt = 0 }
	if math.abs(value - state.value) > 1e-9 then
		state.untilAt = clock + WORK_HOLD
	end
	state.value = value
	activity[entity] = state
	return clock < state.untilAt
end

return {
	update = function(c)
		if not c.audio then
			return
		end
		clock += c.dt
		since += c.dt
		if since < PERIOD then
			return
		end
		since = 0
		local sum, side = {}, {}
		local function add(name: string, x: number, y: number, weight: number?)
			local near = c:nearness(x, y, HEARING) * (weight or 1)
			if near <= 0 then
				return
			end
			sum[name] = (sum[name] or 0) + near
			side[name] = (side[name] or 0) + near * c:side(x)
		end
		-- Шахта в пуске: створки — гидравлика, потом пар, потом разгон двигателя; MCV, который разворачивается или
		-- сворачивается, — гидравлика; ракеты в полёте ревут.
		local clock = c.tick + c.alpha
		for _, e in c:each({ "Silo", "Position" }) do
			local silo = c:get(e, "Silo")
			local kind = c:proto(e)
			local warhead = kind and kind.data.warhead
			if silo.start >= 0 and warhead then
				local share = (clock - silo.start) / math.floor(warhead.launch / c.step + 0.5)
				local at = c:get(e, "Position")
				if share < DOORS then
					add("hydraulic", at.x, at.y)
				end
				if share >= STEAM then
					add("steam", at.x, at.y, (share - STEAM) / (1 - STEAM))
				end
				if share >= RISE then
					add("rocket", at.x, at.y, ((share - RISE) / (1 - RISE)) ^ 2)
				end
			end
		end
		for _, e in c:each({ "Converting", "Position" }) do
			local at = c:get(e, "Position")
			add("hydraulic", at.x, at.y, 0.6)
		end
		local speed = c.protos.buildings.silo.data.warhead.speed
		for _, e in c:each({ "Missile" }) do
			local x, y = missiles.at(c:get(e, "Missile"), clock, c.step, speed)
			add("rocket", x, y)
		end
		for _, e in c:each({ "Chaser" }) do
			local x, y = missiles.chaserAt(c:get(e, "Chaser"), clock)
			add("rocket", x, y, 0.5)
		end
		local seen = {}
		for _, e in c:each({ "Building", "Position", "Owner" }) do
			seen[e] = true
			local at = c:get(e, "Position")
			-- Горящий реактор пульсирует, чей бы ни был.
			local burning = economy.burning(c, e)
			if burning then
				add("reactor", at.x, at.y)
			end
			-- Купол щита поёт, пока держится.
			local shield = c:get(e, "Shield")
			if shield and shield.charge > 0 then
				add("dome", at.x, at.y)
			end
			if not c:mine(e) then
				continue
			end
			local kind = c:proto(e)
			-- Реактор гудит, только пока горит стержень.
			if kind and kind.data and (kind.data.power or 0) > 0 and (not kind.data.burns or burning) then
				add("hum", at.x, at.y)
			end
			local producer = c:get(e, "Producer")
			if producer and producer.unit ~= "" and busy(e, producer.progress) then
				add("machinery", at.x, at.y)
			end
		end
		-- Перегруженные электростанции трещат.
		for e, state in economy.states(c) do
			local at = state == "overload" and c:get(e, "Position")
			if at then
				add("overload", at.x, at.y)
			end
		end
		-- Стройка стучит, пока движется: без материалов молчит.
		for _, e in c:each({ "Site", "Position" }) do
			seen[e] = true
			if busy(e, c:get(e, "Site").progress) then
				local at = c:get(e, "Position")
				add("construct", at.x, at.y)
			end
		end
		-- Ремонт шипит сваркой там, где работает.
		for _, e in c:each({ "Repair", "Position" }) do
			local repair = c:get(e, "Repair")
			local at = repair.working and repair.target >= 0 and c:alive(repair.target) and c:get(repair.target, "Position")
			if at then
				add("weld", at.x, at.y)
			end
		end
		-- Луч грузовика гудит, пока переносит груз.
		for _, e in c:each({ "Beam", "Position" }) do
			if #c:get(e, "Beam").links > 0 then
				local at = c:get(e, "Position")
				add("tractor", at.x, at.y)
			end
		end
		-- Турель зудит, пока поворачивается.
		local turned = {}
		for _, e in c:each({ "Attached", "Armed", "Facing" }) do
			local angle = c:get(e, "Facing").angle
			local before = facings[e]
			turned[e] = angle
			local delta = before and math.abs((angle - before + math.pi) % (2 * math.pi) - math.pi)
			if delta and delta > SERVO_MIN then
				local at = c:get(e, "Position")
				if at then
					add("servo", at.x, at.y)
				end
			end
		end
		facings = turned
		-- Накопитель пищит, пока через него идёт ток.
		for _, e in c:each({ "Accumulator", "Position" }) do
			if math.abs(c:get(e, "Accumulator").flow) > 1e-9 then
				local at = c:get(e, "Position")
				add("charge", at.x, at.y)
			end
		end
		-- Груз в трубах звучит там, докуда дотёк.
		for _, e in c:each({ "Batch" }) do
			local batch = c:get(e, "Batch")
			local share = (clock - batch.sent) / math.max(1, batch.arrive - batch.sent)
			if share >= 0 and share <= 1 then
				local points = {}
				for _, node in batch.path do
					local at = c:alive(node) and c:get(node, "Position")
					if at then
						table.insert(points, at)
					end
				end
				if #points > 0 then
					local at = points[math.min(#points, math.floor(share * #points) + 1)]
					add("flow", at.x, at.y)
				end
			end
		end
		for e in activity do
			if not seen[e] then
				activity[e] = nil
			end
		end
		for name, level in LEVELS do
			local total = sum[name] or 0
			c.audio:loop(name, level * (1 - math.exp(-total / (SATURATES[name] or SATURATE))), if total > 0 then side[name] / total else 0)
		end
	end,
}
