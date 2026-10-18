--!strict
-- Вид сущности по её Proto — одинаково у хоста (ctx) и клиента (c): у них разные proto(), а таблица видов
-- (w.protos — раздел → имя → вид) общая.

local kinds = {}

-- Виды по номерам, по таблице видов: она у партии одна, перечитывать её незачем.
local index = setmetatable({}, { __mode = "k" }) :: { [any]: { [number]: any } }

local function byId(protos): { [number]: any }
	local found = index[protos]
	if found then
		return found
	end
	found = {}
	for _, section in protos do
		for _, kind in section do
			if type(kind) == "table" and kind.id then
				found[kind.id] = kind
			end
		end
	end
	index[protos] = found
	return found
end

-- Вид сущности; нет — nil.
function kinds.of(w, e: number)
	local proto = w:get(e, "Proto")
	return proto and byId(w.protos)[proto.id]
end

-- Вид по номеру; нет — nil.
function kinds.byId(w, id: number?)
	return if id then byId(w.protos)[id] else nil
end

-- Это сущность вида kind?
function kinds.is(w, e: number, kind): boolean
	local proto = w:get(e, "Proto")
	return proto ~= nil and kind ~= nil and proto.id == kind.id
end

-- Механики с equip, по именам: их list на каждую таблицу видов.
local equippers = setmetatable({}, { __mode = "k" }) :: { [any]: { any } }

-- Снаряжает сущность вида: каждая механика с equip(вид, сущность, все виды) добавляет свои компоненты по данным вида.
-- Так здание или юнит любого мода получает склад, щит или магазин, а механика другого мода — свои компоненты у видов
-- base. Возвращает ту же сущность.
function kinds.equip(kind, entity, protos)
	local list = equippers[protos]
	if not list then
		local names = {}
		for name, mechanic in protos.mechanics or {} do
			if type(mechanic) == "table" and type(mechanic.equip) == "function" then
				table.insert(names, name)
			end
		end
		table.sort(names)
		list = {}
		for _, name in names do
			table.insert(list, protos.mechanics[name].equip)
		end
		equippers[protos] = list
	end
	for _, equip in list do
		equip(kind, entity, protos)
	end
	return entity
end

return kinds
