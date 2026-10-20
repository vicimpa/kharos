--!strict
-- Союзы игроков (allies.ts). Союз — группа во главе с игроком: глава его предлагает и принимает, он же исключает рядовых
-- и распускает союз целиком; рядовой может только выйти сам. Кто предложил — тот и глава: у двух одиночек главой
-- становится предложивший, а входящий в готовую группу ей и подчиняется. Приняв союз у одного, игрок становится
-- союзником всех участников группы. Союзников не атакуют, разведка у них общая (движок: Player.allies).
--
-- Всё лежит в Player каждого: allies — с кем союз (полный список группы), head — номер главы (-1 — ни с кем),
-- offered — кому игрок предложил и ждёт ответа, asked — кто предложил ему. Правки команд движок выполняет после них,
-- поэтому здесь — книга: записи игроков читаются раз, правятся в памяти и пишутся разом (commit).

local allies = {}

export type Record = { entity: number, allies: { number }, head: number, offered: { number }, asked: { number }, changed: boolean }
export type Book = { [number]: Record }

-- Копия списка: таблицы из ctx:get не клонируются (защищённая метатаблица).
local function copy(list: { number }?): { number }
	local out = {}
	for _, item in list or {} do
		table.insert(out, item)
	end
	return out
end

local function without(list: { number }, player: number): { number }
	local out = {}
	for _, other in list do
		if other ~= player then
			table.insert(out, other)
		end
	end
	return out
end

-- Записи всех игроков.
function allies.book(ctx): Book
	local book: Book = {}
	for _, e in ctx:each({ "Player" }) do
		local info = ctx:get(e, "Player")
		book[info.id] = { entity = e, allies = copy(info.allies), head = info.head or -1, offered = copy(info.offered), asked = copy(info.asked), changed = false }
	end
	return book
end

-- Пишет изменённые записи.
function allies.commit(ctx, book: Book)
	for _, record in book do
		if record.changed then
			ctx:set(record.entity, "Player", { allies = record.allies, head = record.head, offered = record.offered, asked = record.asked })
		end
	end
end

local function touch(record: Record): Record
	record.changed = true
	return record
end

-- В союзе ли два игрока.
function allies.allied(book: Book, a: number, b: number): boolean
	local record = book[a]
	return a ~= b and record ~= nil and table.find(record.allies, b) ~= nil
end

-- Союз заключён: группы from и to сливаются. Главой остаётся глава принявшей стороны — у двух одиночек это
-- предложивший, у готовой группы её глава.
local function merge(book: Book, from: number, to: number)
	local mine, theirs = book[from], book[to]
	local group: { [number]: boolean } = { [from] = true, [to] = true }
	for _, other in mine.allies do
		group[other] = true
	end
	for _, other in theirs.allies do
		group[other] = true
	end
	local head = if #theirs.allies > 0 then theirs.head elseif #mine.allies > 0 then mine.head else to
	local members = {}
	for member in group do
		table.insert(members, member)
	end
	table.sort(members)
	for _, member in members do
		local record = book[member]
		if not record then
			continue
		end
		touch(record)
		record.allies = without(members, member)
		record.head = head
		local offered, asked = {}, {}
		for _, other in record.offered do
			if not group[other] then
				table.insert(offered, other)
			end
		end
		for _, other in record.asked do
			if not group[other] then
				table.insert(asked, other)
			end
		end
		record.offered, record.asked = offered, asked
	end
end

-- Предложение союза from → to; если to уже предлагал — союз заключён. Предлагают и принимают только одиночки и главы.
-- Итог: allied, offered, already, pending, refused, fromMember, toMember.
function allies.offer(book: Book, from: number, to: number): string
	local mine, theirs = book[from], book[to]
	if from == to or not mine or not theirs then
		return "refused"
	end
	if table.find(mine.allies, to) then
		return "already"
	end
	if mine.head >= 0 and mine.head ~= from then
		return "fromMember"
	end
	if table.find(mine.asked, to) then
		merge(book, from, to)
		return "allied"
	end
	if theirs.head >= 0 and theirs.head ~= to then
		return "toMember"
	end
	if table.find(mine.offered, to) then
		return "pending"
	end
	table.insert(touch(mine).offered, to)
	table.insert(touch(theirs).asked, from)
	return "offered"
end

-- Рядовой покидает группу: с ним рвутся все его связи, у оставшихся связи друг с другом целы.
local function detach(book: Book, member: number)
	local mine = book[member]
	for _, other in mine.allies do
		local record = book[other]
		if record then
			touch(record)
			record.allies = without(record.allies, member)
			-- Оставшемуся одному глава больше не нужен: он снова одиночка.
			if #record.allies == 0 then
				record.head = -1
			end
		end
	end
	touch(mine)
	mine.allies, mine.head = {}, -1
end

-- Игрок покидает союз сам: рядовой выходит, глава распускает союз. Итог: left, dissolved, nothing.
function allies.exit(book: Book, player: number): string
	local mine = book[player]
	if not mine or #mine.allies == 0 then
		return "nothing"
	end
	if mine.head == player then
		for _, member in { player, table.unpack(mine.allies) } do
			local record = book[member]
			if record then
				touch(record)
				record.allies, record.head = {}, -1
			end
		end
		return "dissolved"
	end
	detach(book, player)
	return "left"
end

-- Игрок from рвёт с to всё, что между ними есть: союз (только глава), своё предложение или его. Итог: kicked,
-- withdrawn, declined, notHead, nothing.
function allies.breakWith(book: Book, from: number, to: number): string
	local mine = book[from]
	if not mine then
		return "nothing"
	end
	if table.find(mine.allies, to) then
		if mine.head ~= from then
			return "notHead"
		end
		detach(book, to)
		return "kicked"
	end
	local result = if table.find(mine.offered, to) then "withdrawn" elseif table.find(mine.asked, to) then "declined" else "nothing"
	if result == "nothing" then
		return result
	end
	for _, pair in { { from, to }, { to, from } } do
		local record = book[pair[1]]
		if record then
			touch(record)
			record.allies = without(record.allies, pair[2])
			record.asked = without(record.asked, pair[2])
			record.offered = without(record.offered, pair[2])
		end
	end
	return result
end

-- Игрок начинает заново: все его союзы и предложения пропадают. Глава, начавший заново, распускает союз.
function allies.forget(book: Book, player: number)
	local mine = book[player]
	if not mine then
		return
	end
	local others = {}
	for _, other in mine.offered do
		others[other] = true
	end
	for _, other in mine.asked do
		others[other] = true
	end
	allies.exit(book, player)
	for other in others do
		allies.breakWith(book, player, other)
	end
end

return allies
