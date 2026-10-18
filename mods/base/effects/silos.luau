--!strict
-- Ракетные шахты и перехватчики на экране — перенос siloVariant и варианта перехватчика из buildingsPass.ts. Шахта в
-- пуске: створки расходятся в первую doors долю срока пуска, ракета поднимается в открытом стволе с rise до старта;
-- с готовой боеголовкой шахта работает. Перехватчик показывает, сколько у него ракет, и работает, пока они есть;
-- чужой — всегда пустым: это знает хозяин.

local silos = {}

silos.data = {
	-- Доли срока пуска: до какой створки расходятся, с какой ракета поднимается (DOORS_SHARE, RISE_FROM); ступеней
	-- створок и подъёма — как у облика шахты (SILO_DOOR_STEPS, SILO_RISE_STEPS).
	doors = 0.35,
	rise = 0.6,
	doorSteps = 8,
	riseSteps = 4,
}

function silos.update(c)
	local d = silos.data
	local clock = c.tick + c.alpha
	for _, e in c:each({ "Silo" }) do
		local silo = c:get(e, "Silo")
		local kind = c:proto(e)
		local warhead = kind and kind.data.warhead
		local variant = 0
		if warhead and silo.start >= 0 then
			local share = (clock - silo.start) / math.floor(warhead.launch / c.step + 0.5)
			local doors = math.min(d.doorSteps - 1, math.floor(share / d.doors * (d.doorSteps - 1)))
			variant = if share < d.rise then doors else d.doorSteps - 1 + math.min(d.riseSteps, math.ceil((share - d.rise) / (1 - d.rise) * d.riseSteps))
		end
		c:dress(e, { variant = math.max(0, variant), working = if silo.ready and not c:has(e, "Site") then true else nil })
	end
	for _, e in c:each({ "Interceptor" }) do
		local count = if c:mine(e) then c:get(e, "Interceptor").missiles else 0
		c:dress(e, { variant = count, working = if count > 0 and not c:has(e, "Site") then true else nil })
	end
end

return silos
