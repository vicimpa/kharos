--!strict
-- Кнопки стройки, на которые игрок уже наводил или нажимал (seen.ts): здания и инструменты протяжки. Остальные открытые
-- сетка подсвечивает как новые, а с ними и их разделы, — так игрок видит, что появилось и куда нажать. Хранится в
-- настройках приложения (c.app), а не в мире: это знакомство игрока с игрой, и в новой партии знакомое уже не новое.

local seen = {}

local cache: { [string]: boolean }? = nil

local function load(c): { [string]: boolean }
	if not cache then
		local list = {}
		for _, key in c.app:get("seen") or {} do
			if type(key) == "string" then
				list[key] = true
			end
		end
		cache = list
	end
	return cache :: { [string]: boolean }
end

-- Видел ли игрок эту кнопку — навёл или нажал: вид здания или инструмент протяжки.
function seen.is(c, key: string): boolean
	return load(c)[key] == true
end

-- Игрок навёл на кнопку или нажал её: дальше она не новая.
function seen.mark(c, key: string)
	local known = load(c)
	if known[key] then
		return
	end
	known[key] = true
	local list = {}
	for name in known do
		table.insert(list, name)
	end
	table.sort(list)
	c.app:set("seen", list)
end

return seen
