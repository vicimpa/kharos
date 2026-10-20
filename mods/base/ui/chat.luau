--!strict
-- Чат партии по сети (chat.ts), как в Minecraft: Enter (или «/») открывает строку ввода, Enter отправляет, Escape
-- закрывает. Закрытый чат показывает свежие сообщения, и через SHOWN секунд они гаснут; открытый — всю историю с
-- прокруткой. Над строкой — подсказки дополнения команд и ников: Tab подставляет, стрелки выбирают. Своя игра — чата нет.

local chat = {}

-- Сколько секунд сообщение видно, пока чат закрыт, и сколько из них оно гаснет; сколько последних видно закрытым;
-- сколько подсказок над строкой; ширина.
local SHOWN = 10
local FADE = 1
local RECENT = 8
local SUGGESTIONS = 6
local WIDTH = 480

-- Цвета чата — как у Minecraft, а не как у остального интерфейса: так его узнают.
local WHITE = "#ffffff"
local SHADE = "#3f3f3f"
local SYSTEM = "#ffff55"
local SYSTEM_SHADE = "#3f3f15"
local WHISPER = "#aaaaaa"
local OWN = "#ffe066"

local open = false
-- Только что открыт: строка в этом кадре берёт фокус.
local opening = false
local draft = ""
-- Строка спрашивает пароль администратора: набранное скрыто и уходит как /admin <пароль>.
local password = false
-- Какая подсказка дополнения выбрана стрелками.
local chosen = 1

local function close()
	open, draft, password, chosen = false, "", false, 1
end

-- Текст сервера ключом словаря — на языке игрока; параметры-ключи — тоже.
local function textOf(c, text: any): string
	if type(text) == "string" then
		return text
	end
	if type(text) ~= "table" or type(text.key) ~= "string" then
		return ""
	end
	local params = {}
	for key, value in text.params or {} do
		params[key] = if type(value) == "table" then textOf(c, value) else value
	end
	return c:t(text.key, params)
end

-- Слова строки: через пробел, а в двойных кавычках — вместе с пробелами; с тем, как они записаны (кавычки целы).
local function words(text: string): { string }
	local list = {}
	local at = 1
	while at <= #text do
		local first = string.sub(text, at, at)
		if string.match(first, "%s") then
			at += 1
		elseif first == '"' then
			local close = string.find(text, '"', at + 1, true)
			local finish = close or #text
			table.insert(list, string.sub(text, at, finish))
			at = finish + 1
		else
			local finish = (string.find(text, "%s", at) or #text + 1) - 1
			table.insert(list, string.sub(text, at, finish))
			at = finish + 1
		end
	end
	return list
end

local function quote(name: string): string
	return if string.find(name, " ", 1, true) then '"' .. name .. '"' else name
end

-- Команда с аргументами, как она показана игроку: <player> — словом его языка (chat.args).
local function labelOf(c, command): string
	local parts = { "/" .. command.name }
	for _, arg in command.args do
		local key = string.match(arg, "^<(%w+)>$")
		table.insert(parts, if key then "<" .. c:t("chat.args." .. key) .. ">" else arg)
	end
	return table.concat(parts, " ")
end

-- Дополнения для набранного (complete в chatCommands.ts): пока набирается имя команды — подходящие команды, дальше —
-- ники для аргумента <player>. Ник с пробелом — в кавычках.
local function complete(c, text: string, commands, names: { string })
	if string.sub(text, 1, 1) ~= "/" then
		return {}
	end
	local list = words(string.sub(text, 2))
	local _, quotes = string.gsub(text, '"', "")
	if (string.sub(text, -1) == " " and quotes % 2 == 0) or #list == 0 then
		table.insert(list, "")
	end
	local found = {}
	if #list == 1 then
		local typed = string.lower(list[1])
		for _, command in commands do
			if string.sub(command.name, 1, #typed) == typed then
				table.insert(found, { text = "/" .. command.name .. " ", label = labelOf(c, command), help = c:t("chat.help." .. command.name) })
			end
		end
		return found
	end
	local command
	for _, each in commands do
		if each.name == string.lower(list[1]) then
			command = each
		end
	end
	if not command then
		return found
	end
	local arg = command.args[#list - 1]
	if arg ~= "<player>" then
		if arg then
			table.insert(found, { text = text, label = labelOf(c, command), help = c:t("chat.help." .. command.name) })
		end
		return found
	end
	local last = list[#list]
	local head = string.sub(text, 1, #text - #last)
	local typed = string.lower((string.gsub(last, '"', "")))
	for _, name in names do
		if string.sub(string.lower(name), 1, #typed) == typed then
			table.insert(found, { text = head .. quote(name) .. " ", label = name, help = c:t("chat.help." .. command.name) })
		end
	end
	return found
end

-- Строка чата текстом и её цвета.
local function lineOf(c, line): (string, string, string)
	local text = textOf(c, line.text)
	if line.system then
		return if line.name ~= "" then line.name .. " " .. text else text, SYSTEM, SYSTEM_SHADE
	end
	if line.whisper then
		return "<" .. line.name .. " → " .. line.whisper .. "> " .. text, WHISPER, SHADE
	end
	return "<" .. line.name .. "> " .. text, if line.own then OWN else WHITE, SHADE
end

function chat.draw(c)
	if not c.online then
		return
	end
	local ui = c.ui
	local input = c.input
	-- Открывается клавишей, пока в поле ничего не набирают и на карте ничего не выбирают.
	if not open and not input.typing and not c.shared.mode and (input.hits.enter or input.hits["/"]) then
		open, opening = true, true
		draft = if input.hits["/"] then "/" else ""
	end
	local lines = c:chat()
	local known = c:commands()
	local names = {}
	for _, player in c:players() do
		table.insert(names, player.name)
	end
	local width = math.min(WIDTH, ui.width - 24)
	local now = c.time
	local shown = {}
	for index = if open then 1 else math.max(1, #lines - RECENT + 1), #lines do
		local line = lines[index]
		if open or now - line.at < SHOWN then
			table.insert(shown, line)
		end
	end
	if not open and #shown == 0 then
		return
	end
	local suggestions = if password then {} else complete(c, draft, known.commands, names)
	while #suggestions > SUGGESTIONS do
		table.remove(suggestions)
	end
	local pick = math.min(chosen, #suggestions)
	local inset = c.shared.inset or {}
	local bottom = math.max(inset.bottom or 0, inset.minimap or 0) + 8
	-- Закрытый чат не держит мышь: сквозь него щёлкают по карте.
	ui:box({ id = "chat", anchor = { left = 12, bottom = bottom }, width = width, direction = "column", passive = not open }, function()
		ui:box({ id = "chat:lines", direction = "column", maxHeight = math.floor(ui.height * 0.4), scroll = open, clip = true, align = "stretch" }, function()
			for _, line in shown do
				local fade = if open then 1 else math.min(1, (SHOWN - (now - line.at)) / FADE)
				local text, color, shadow = lineOf(c, line)
				ui:box({ background = "#00000073", padding = { 1, 6 }, alpha = fade }, function()
					ui:text(text, { color = color, shadow = shadow, lift = 2, wrap = width - 12 })
				end)
			end
		end)
		if not open then
			return
		end
		if #suggestions > 0 then
			ui:box({ direction = "column", align = "stretch", padding = { 2, 0, 0, 0 } }, function()
				for index, item in suggestions do
					local id = "chat:suggestion:" .. index
					ui:box({ id = id, background = "#000000b3", padding = { 1, 6 }, direction = "row", gap = 6 }, function()
						ui:text(item.label, { color = if index == pick then SYSTEM else WHITE })
						ui:text(item.help, { color = WHISPER, ellipsis = true })
					end)
					if ui:clicked(id) then
						draft, chosen = item.text, 1
					end
				end
			end)
		end
		local field = ui:input("chat:input", draft, {
			width = width,
			password = password,
			placeholder = if password then c:t("hud.adminPassword") elseif known.admin then c:t("hud.adminMode") else nil,
			maxLength = 200,
			focus = opening,
			background = "#00000099",
			outline = if known.admin then "#ff5555" else nil,
		})
		opening = false
		if field.value ~= draft then
			draft, chosen = field.value, 1
		end
		for _, key in field.keys do
			if key == "Escape" or key == "Blur" then
				close()
			elseif key == "Tab" and suggestions[pick] then
				draft, chosen = suggestions[pick].text, 1
			elseif (key == "ArrowUp" or key == "ArrowDown") and #suggestions > 0 then
				chosen = (pick - 1 + (if key == "ArrowUp" then -1 else 1)) % #suggestions + 1
			elseif key == "Enter" then
				-- Команда с паролем (/admin) спрашивает его отдельно, скрытым полем: в строке чата его видно.
				local head = string.lower(words(string.sub(draft, 2))[1] or "")
				local secret = false
				for _, command in known.commands do
					if command.secret and string.sub(draft, 1, 1) == "/" and head == command.name then
						secret = true
					end
				end
				if not password and secret then
					password, draft = true, ""
					continue
				end
				if password then
					if draft ~= "" then
						c:say("/admin " .. draft)
					end
				elseif string.match(draft, "%S") then
					c:say(draft)
				end
				close()
			end
		end
	end)
end

return chat
