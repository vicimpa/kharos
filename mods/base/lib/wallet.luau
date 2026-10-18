--!strict
-- Кошельки игроков: сущность игрока с компонентом Player (mechanics/players.luau) по номеру — в ctx.storage.players.

local wallet = {}

-- Сущность игрока по его номеру; нет — nil.
function wallet.of(ctx, player: number): number?
	local list = ctx.storage.players
	return list and list[tostring(player)]
end

function wallet.credits(ctx, player: number): number
	local entity = wallet.of(ctx, player)
	return if entity then ctx:get(entity, "Player").credits else 0
end

-- Списывает amount кредитов, если хватает: true — списано.
function wallet.pay(ctx, player: number, amount: number): boolean
	local entity = wallet.of(ctx, player)
	if not entity then
		return false
	end
	local state = ctx:get(entity, "Player")
	if state.credits < amount then
		return false
	end
	ctx:set(entity, "Player", { credits = state.credits - amount })
	return true
end

function wallet.refund(ctx, player: number, amount: number)
	local entity = wallet.of(ctx, player)
	if entity then
		ctx:set(entity, "Player", { credits = ctx:get(entity, "Player").credits + amount })
	end
end

-- Кошелёк одной системы: ctx:set откладывается до конца системы, поэтому несколько трат за её ход считаются здесь и
-- пишутся разом (flush). Целые кредиты — credits, дробная часть — earned, как spend и earn в economy.ts.
export type Purse = { ctx: any, players: { [number]: { entity: number, credits: number, earned: number, dirty: boolean } } }

function wallet.purse(ctx): Purse
	return { ctx = ctx, players = {} }
end

local function account(purse: Purse, player: number)
	local found = purse.players[player]
	if found then
		return found
	end
	local entity = wallet.of(purse.ctx, player)
	if not entity then
		return nil
	end
	local state = purse.ctx:get(entity, "Player")
	found = { entity = entity, credits = state.credits, earned = state.earned, dirty = false }
	purse.players[player] = found
	return found
end

-- Кредиты на счету с учётом трат этой системы.
function wallet.balance(purse: Purse, player: number): number
	local it = account(purse, player)
	return if it then it.credits else 0
end

-- Списывает amount (можно дробное), если хватает: дробь копится в earned, со счёта уходят целые (spend).
function wallet.spend(purse: Purse, player: number, amount: number): boolean
	local it = account(purse, player)
	if not it then
		return false
	end
	local left = it.earned - amount
	local whole = if left < 0 then math.ceil(-left) else 0
	if it.credits < whole then
		return false
	end
	it.credits -= whole
	it.earned = left + whole
	it.dirty = true
	return true
end

-- Начисляет amount (можно дробное): на счёт — целые, дробь копится (earn).
function wallet.earn(purse: Purse, player: number, amount: number)
	local it = account(purse, player)
	if not it or amount <= 0 then
		return
	end
	local total = it.earned + amount
	local whole = math.floor(total)
	it.credits += whole
	it.earned = total - whole
	it.dirty = true
end

-- Начисляет целую сумму сразу на счёт (addCredits).
function wallet.add(purse: Purse, player: number, amount: number)
	local it = account(purse, player)
	if it then
		it.credits += amount
		it.dirty = true
	end
end

-- Записывает траты системы.
function wallet.flush(purse: Purse)
	for _, it in purse.players do
		if it.dirty then
			purse.ctx:set(it.entity, "Player", { credits = it.credits, earned = it.earned })
			it.dirty = false
		end
	end
end

return wallet
