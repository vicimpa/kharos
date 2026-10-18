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

-- Это сущность вида kind?
function kinds.is(w, e: number, kind): boolean
	local proto = w:get(e, "Proto")
	return proto ~= nil and kind ~= nil and proto.id == kind.id
end

return kinds
