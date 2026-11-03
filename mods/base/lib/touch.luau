--!strict
-- Сенсорная замена клавиши Shift: переключатель в панели поля действует на приказы, выделение, патруль и группы.

local touch = {}

function touch.shift(c): boolean
	return c.input.keys.shift or c.shared.touchShift == true
end

return touch
