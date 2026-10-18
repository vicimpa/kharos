--!strict
-- Покрытие на карте — чтение слоёв layers/paving (канал 0 — вид: 1 фундамент, 2 дорога; канал 1 — хозяин) и
-- layers/paveWork (номер работы над покрытием на тайле). Без зависимостей: его читают и место под здание
-- (lib/placement), и правила стройки; правила покрытия — lib/paving.

local surface = {}

-- Виды покрытия по коду в слое.
local KINDS = { "foundation", "road" }

-- Есть ли покрытие в партии: слой объявлен и ход его знает.
function surface.enabled(w): boolean
	local rules = w.game.data and w.game.data.rules
	return rules ~= nil and rules.surface == "paving"
end

-- Готовое покрытие тайла: вид и хозяин; нет — nil.
function surface.laid(w, x: number, y: number): (string?, number)
	if not surface.enabled(w) then
		return nil, 0
	end
	local code = w:layer("paving", x, y)
	if code == 0 then
		return nil, 0
	end
	return KINDS[code], w:layer("paving", x, y, 1)
end

-- Лежит ли на тайле готовое покрытие этого вида. Разбираемое ещё лежит и действует.
function surface.isPaved(w, kind: string, x: number, y: number): boolean
	return (surface.laid(w, x, y)) == kind
end

-- Работа над покрытием на тайле — укладка или разбор (paving.at); нет — nil.
function surface.at(w, x: number, y: number): number?
	if not surface.enabled(w) then
		return nil
	end
	local e = w:layer("paveWork", x, y)
	if e == 0 or not w:alive(e) or not w:has(e, "Pave") then
		return nil
	end
	return e
end

-- Тайл работы над покрытием: она стоит посреди него.
function surface.tileOf(w, e: number): (number, number)
	local at = w:get(e, "Position")
	return math.floor(at.x), math.floor(at.y)
end

-- Дорога ли на тайле — готовая или та, что кладут: по ней ездят, строить на ней нельзя.
function surface.isRoadway(w, x: number, y: number): boolean
	if surface.isPaved(w, "road", x, y) then
		return true
	end
	local e = surface.at(w, x, y)
	local pave = e and w:get(e, "Pave")
	return pave ~= nil and pave.kind == "road" and not pave.remove
end

-- Хозяин готового покрытия на тайле; покрытия нет — nil.
function surface.ownerAt(w, x: number, y: number): number?
	local kind, owner = surface.laid(w, x, y)
	return if kind then owner else nil
end

-- Вид покрытия на тайле, как его рисуют: что на нём кладут или разбирают, а нет работы — готовое; заменяемое рисуется
-- новым. Второе — идёт ли над ним работа.
function surface.drawnAt(w, x: number, y: number): (string?, boolean)
	local e = surface.at(w, x, y)
	if e then
		return w:get(e, "Pave").kind, true
	end
	return (surface.laid(w, x, y)), false
end

return surface
