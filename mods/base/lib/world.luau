--!strict
-- Общие вопросы к миру — хосту (ctx) и клиенту (c): чья сущность, готово ли здание, внутри ли карты тайл, чей черёд.

local world = {}

-- Хозяин сущности; нет — 0.
function world.ownerOf(w, e: number): number
	local owner = w:get(e, "Owner")
	return if owner then owner.player else 0
end

-- Своё готовое здание: живое, игрока player, не стройка и не разбор.
function world.isReady(w, player: number, e: number): boolean
	local owner = w:alive(e) and w:get(e, "Owner")
	return owner ~= nil and owner ~= false and owner.player == player and w:has(e, "Building") and not w:has(e, "Site")
end

-- Тайл внутри карты партии (data.size: от −size до size); без размера — любой.
function world.inBounds(w, x: number, y: number): boolean
	local size = w.game.data and w.game.data.size
	return not size or (x >= -size and y >= -size and x < size and y < size)
end

-- Черёд сущности в работе раз в ticks тиков: сущности расходятся по тикам, а не считаются все разом.
function world.onTurn(ctx, e: number, ticks: number): boolean
	return (ctx.tick + e) % ticks == 0
end

return world
