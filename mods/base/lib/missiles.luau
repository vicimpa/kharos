--!strict
-- Ракеты в полёте, общий хосту и клиенту. Места ядерной ракеты на карте нет: она летит по прямой с известной скоростью,
-- и клиент ведёт её сам по тику старта.

local missiles = {}

-- Высота полёта ядерной ракеты над землёй, в тайлах, и за сколько секунд она её набирает после старта и теряет перед
-- ударом. На симуляцию высота не влияет: по ней рисуются ракета, встреча с перехватчиком и вспышка.
missiles.CRUISE = 2.5
missiles.CLIMB = 3

-- На какой высоте ракета, которая летит age секунд и которой осталось left тайлов; speed — её скорость.
function missiles.lift(age: number, left: number, speed: number): number
	return missiles.CRUISE * math.max(0, math.min(1, age / missiles.CLIMB, left / (speed * missiles.CLIMB)))
end

-- Где ракета в момент clock (тик с долей): над какой точкой земли, как высоко и куда летит.
function missiles.at(missile, clock: number, step: number, speed: number)
	local reach = math.sqrt((missile.toX - missile.fromX) ^ 2 + (missile.toY - missile.fromY) ^ 2)
	reach = if reach > 0 then reach else 1
	local headingX, headingY = (missile.toX - missile.fromX) / reach, (missile.toY - missile.fromY) / reach
	local age = math.max(0, (clock - missile.born) * step)
	local flown = math.min(reach, speed * age)
	return missile.fromX + headingX * flown, missile.fromY + headingY * flown, missiles.lift(age, reach - flown, speed), headingX, headingY
end

-- Где ракета-перехватчик в момент clock: со станка уходит круто вверх и к встрече выравнивается на высоте ракеты.
function missiles.chaserAt(chaser, clock: number)
	local share = math.min(1, math.max(0, (clock - chaser.born) / math.max(1, chaser.arrive - chaser.born)))
	return chaser.fromX + (chaser.toX - chaser.fromX) * share, chaser.fromY + (chaser.toY - chaser.fromY) * share, chaser.lift * (1 - (1 - share) ^ 2)
end

return missiles
