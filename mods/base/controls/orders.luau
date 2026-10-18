--!strict
-- Приказы правой кнопкой: выделенные юниты едут в точку, выделенный завод ставит туда точку сбора. Касанием — долгое
-- нажатие на земле. Куда едут — видно пунктиром пути у выделенных (controls/select).

local orders = {}

orders.data = {
	-- Долгое касание, секунд.
	hold = 0.5,
}

local held: { time: number, x: number, y: number }? = nil

local function order(c, x: number, y: number)
	local units, building = {}, nil
	for _, e in c.shared.selection or {} do
		if c:has(e, "Drive") then
			table.insert(units, e)
		elseif c:has(e, "Producer") then
			building = e
		end
	end
	if #units > 0 then
		c:send("move", { units = units, x = x, y = y })
		c:sound("order", { volume = 0.35 })
	elseif building then
		c:send("rally", { building = building, x = x, y = y })
		c:sound("place", { volume = 0.35 })
	end
end

function orders.update(c)
	local input = c.input
	if c.shared.paused then
		held = nil
		return
	end
	if input.pressed.right and input.inside and not input.over_ui then
		order(c, input.wx, input.wy)
	end
	-- Касание: долгое нажатие на месте — приказ.
	if input.pressed.left and input.touch and not input.over_ui then
		held = { time = c.time, x = input.x, y = input.y }
	end
	if held then
		local moved = math.abs(input.x - held.x) + math.abs(input.y - held.y) > 8
		if not input.down.left or moved then
			held = nil
		elseif c.time - held.time > orders.data.hold then
			order(c, input.wx, input.wy)
			c.shared.swallow = true
			held = nil
		end
	end
	if input.hits.x then
		c:send("stop", { units = c.shared.selection or {} })
	end
end

return orders
