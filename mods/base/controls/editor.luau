--!strict
-- Мышь и клавиши редактора — перенос createEdit из editorPanel.ts. Что делает щелчок, решает инструмент панели
-- (c.shared.editor, ui/editor): «Выбор» — щелчок выбирает юнит, здание или месторождение, рамка — всё разом, Shift —
-- добавить или снять, выбранное тащится мышью вместе; рамку камеры игрока тянут за край — двигают, за угол — меняют
-- масштаб. «Карта» — кисть красит, пока тянут; «Здания», «Юниты», «Ресурсы» — щелчок ставит; призрак показывает, что
-- встанет. Правый щелчок сносит то, что под указателем, или всё выбранное; Delete и Backspace — выбранное; Escape —
-- снимает приказ мышью. «Приказ мышью» — следующий щелчок отдаёт выбранным юнитам приказ от имени их владельцев.

local deposits = require("lib/deposits")
local editor = require("lib/editor")
local placement = require("lib/placement")

local controls = {}

controls.data = {
	-- Сдвиг указателя, после которого щелчок — протяжка, в пикселях.
	threshold = 4,
}

-- Выбор и пометки (SELECTED, рамки месторождений и камеры).
local SELECTED, MARK, GHOST, BLOCKED = 0x59ff73, 0xffd94d, { 0.7, 0.7, 0.7, 0.7 }, { 0.7, 0.14, 0.1, 0.7 }

local pressed: { x: number, y: number, wx: number, wy: number }? = nil
local dragging: { kind: string, x: number, y: number }? = nil
local last = ""

-- Состояние панели: инструмент, игрок, кисть, что ставить, выбранные месторождения.
function controls.state(c)
	local state = c.shared.editor
	if not state then
		local players = editor.players(c)
		state = {
			tool = "select",
			player = players[1] or 1,
			brush = { terrain = 2, shape = "square" },
			size = 3,
			building = "generator",
			unit = "tank",
			kind = "metal",
			reserve = c.protos.deposits.metal.data.max,
			ordering = false,
			spots = {},
		}
		c.shared.editor = state
	end
	return state
end

-- Правка: ответ — в строку состояния; отправлена — несохранённое помечено.
function controls.edit(c, op)
	c.shared.editorStatus = nil
	c.shared.editorDirty = true
	c:send("edit", op)
end

-- Выбранное: живые сущности и месторождения (по левым верхним тайлам).
function controls.selection(c): { number }
	local list = {}
	for _, e in c.shared.selection or {} do
		if c:alive(e) then
			table.insert(list, e)
		end
	end
	c.shared.selection = list
	return list
end

function controls.spots(c): { editor.Spot }
	local state = controls.state(c)
	local found = {}
	for _, at in state.spots do
		local spot = editor.depositAt(c, at.x, at.y)
		if spot then
			table.insert(found, spot)
		end
	end
	return found
end

-- Сносит выбранное.
function controls.eraseSelection(c)
	local state = controls.state(c)
	local entities = controls.selection(c)
	local spots = controls.spots(c)
	if #entities > 0 then
		controls.edit(c, { op = "erase", entities = entities })
	end
	if #spots > 0 then
		local list = {}
		for _, spot in spots do
			table.insert(list, { x = spot.x, y = spot.y })
		end
		controls.edit(c, { op = "removeDeposit", spots = list })
	end
	c.shared.selection = {}
	state.spots = {}
end

-- Где ляжет месторождение под тайлом (x, y): серединой под ним, как здание.
local function depositSpot(x: number, y: number): (number, number)
	return x - math.floor(deposits.SIZE / 2), y - math.floor(deposits.SIZE / 2)
end

-- Рамка камеры выбранного игрока: что видно на экране размером с этот, в тайлах.
local function cameraBox(c, state)
	local view = state.player > 0 and editor.camera(c, state.player)
	if not view then
		return nil
	end
	local halfWidth, halfHeight = c.screen.w / view.zoom / 2, c.screen.h / view.zoom / 2
	return { view = view, left = view.x - halfWidth, top = view.y - halfHeight, right = view.x + halfWidth, bottom = view.y + halfHeight }
end

-- Попала ли точка в рамку камеры: в угол — менять масштаб, в край — двигать.
local function cameraHit(c, state, x: number, y: number): string?
	local box = cameraBox(c, state)
	if not box then
		return nil
	end
	local reach = 10 / c.camera.zoom
	local nearX = math.min(math.abs(x - box.left), math.abs(x - box.right)) < reach
	local nearY = math.min(math.abs(y - box.top), math.abs(y - box.bottom)) < reach
	local withinX = x > box.left - reach and x < box.right + reach
	local withinY = y > box.top - reach and y < box.bottom + reach
	if nearX and nearY then
		return "zoom"
	end
	if (nearX and withinY) or (nearY and withinX) then
		return "camera"
	end
	return nil
end

-- Приказ мышью выбранным юнитам: каждому — от имени его владельца, как правой кнопкой в игре.
local function giveOrders(c, wx: number, wy: number, queue: boolean)
	local byOwner = {}
	for _, e in controls.selection(c) do
		if c:has(e, "Mover") then
			local owner = c:get(e, "Owner")
			local player = if owner then owner.player else 0
			byOwner[player] = byOwner[player] or {}
			table.insert(byOwner[player], e)
		end
	end
	for player, units in byOwner do
		controls.edit(c, { op = "order", player = player, command = { type = "order", units = units, x = wx, y = wy, queue = queue } })
	end
end

-- Рамка в тайлах тонкой линией.
local function frame(c, left: number, top: number, right: number, bottom: number, color: number)
	c.draw:rect(left, top, right, bottom, color, 1, 0.9)
end

-- Нажали левую кнопку в точке (wx, wy).
local function down(c, state, wx: number, wy: number, shift: boolean)
	local x, y = math.floor(wx), math.floor(wy)
	if state.ordering then
		giveOrders(c, wx, wy, shift)
		if not shift then
			state.ordering = false
		end
		return
	end
	if state.tool == "paint" then
		last = x .. "," .. y
		controls.edit(c, { op = "paint", x = x, y = y, size = state.size, brush = state.brush })
	elseif state.tool == "building" then
		local kind = c.protos.buildings[state.building]
		controls.edit(c, { op = "building", type = state.building, x = x - math.floor(kind.data.width / 2), y = y - math.floor(kind.data.height / 2), player = state.player })
	elseif state.tool == "unit" then
		controls.edit(c, { op = "unit", type = state.unit, x = x, y = y, player = state.player })
	elseif state.tool == "deposit" then
		local sx, sy = depositSpot(x, y)
		controls.edit(c, { op = "deposit", x = sx, y = sy, kind = state.kind, reserve = state.reserve })
	elseif state.tool == "select" then
		local hit = cameraHit(c, state, wx, wy)
		if hit then
			dragging = { kind = hit, x = wx, y = wy }
			return
		end
		local target = editor.entityAt(c, wx, wy)
		local spot = if target then nil else editor.depositUnder(c, wx, wy)
		local selection = controls.selection(c)
		local function pickedSpot(at): number?
			for i, other in state.spots do
				if other.x == at.x and other.y == at.y then
					return i
				end
			end
			return nil
		end
		local chosen = if target then table.find(selection, target) ~= nil elseif spot then pickedSpot(spot) ~= nil else false
		if not target and not spot then
			if not shift then
				c.shared.selection = {}
				state.spots = {}
			end
			dragging = { kind = "box", x = wx, y = wy }
		elseif shift and chosen then
			if target then
				table.remove(selection, table.find(selection, target) :: number)
				c.shared.selection = selection
			else
				table.remove(state.spots, pickedSpot(spot) :: number)
			end
		else
			if not shift and not chosen then
				selection = {}
				state.spots = {}
			end
			if target and not table.find(selection, target) then
				table.insert(selection, target)
			elseif spot and not chosen then
				table.insert(state.spots, { x = spot.x, y = spot.y })
			end
			c.shared.selection = selection
			dragging = { kind = "group", x = x, y = y }
		end
	end
end

-- Тянут с зажатой левой.
local function drag(c, state, wx: number, wy: number)
	local x, y = math.floor(wx), math.floor(wy)
	if state.tool == "paint" then
		local tile = x .. "," .. y
		if tile ~= last then
			last = tile
			controls.edit(c, { op = "paint", x = x, y = y, size = state.size, brush = state.brush })
		end
		return
	end
	local held = dragging
	if not held then
		return
	end
	if held.kind == "camera" or held.kind == "zoom" then
		local box = cameraBox(c, state)
		if box then
			local view = box.view
			if held.kind == "camera" then
				controls.edit(c, { op = "camera", player = state.player, camera = { x = view.x + wx - held.x, y = view.y + wy - held.y, zoom = view.zoom } })
				held.x, held.y = wx, wy
			else
				local half = math.max(math.abs(wx - view.x) / c.screen.w, math.abs(wy - view.y) / c.screen.h)
				controls.edit(c, { op = "camera", player = state.player, camera = { x = view.x, y = view.y, zoom = math.clamp(1 / (2 * math.max(half, 1e-3)), 4, 96) } })
			end
		end
	elseif held.kind == "group" and (x ~= held.x or y ~= held.y) then
		-- Выбранное тянут мышью вместе: сдвиг целыми тайлами.
		local dx, dy = x - held.x, y - held.y
		controls.edit(c, { op = "move", entities = controls.selection(c), dx = dx, dy = dy, deposits = state.spots })
		for _, at in state.spots do
			at.x += dx
			at.y += dy
		end
		held.x, held.y = x, y
	end
end

-- Отпустили левую.
local function up(c, state, wx: number, wy: number)
	local held = dragging
	dragging = nil
	last = ""
	if held and held.kind == "box" then
		local left, top = math.min(held.x, wx), math.min(held.y, wy)
		local right, bottom = math.max(held.x, wx), math.max(held.y, wy)
		local selection = controls.selection(c)
		for _, e in editor.entitiesIn(c, left, top, right, bottom) do
			if not table.find(selection, e) then
				table.insert(selection, e)
			end
		end
		c.shared.selection = selection
		for _, spot in editor.depositsInBox(c, left, top, right, bottom) do
			local known = false
			for _, at in state.spots do
				known = known or (at.x == spot.x and at.y == spot.y)
			end
			if not known then
				table.insert(state.spots, { x = spot.x, y = spot.y })
			end
		end
	end
end

-- Правый щелчок: сносит под указателем, а если там выбранное — всё выбранное (secondary).
local function secondary(c, state, wx: number, wy: number)
	local target = editor.entityAt(c, wx, wy)
	local spot = if target then nil else editor.depositUnder(c, wx, wy)
	if not target and not spot then
		return
	end
	local chosen = false
	if target then
		chosen = table.find(controls.selection(c), target) ~= nil
	else
		for _, at in state.spots do
			chosen = chosen or (at.x == spot.x and at.y == spot.y)
		end
	end
	if chosen then
		controls.eraseSelection(c)
	elseif target then
		controls.edit(c, { op = "erase", entities = { target } })
	else
		controls.edit(c, { op = "removeDeposit", spots = { { x = spot.x, y = spot.y } } })
	end
end

-- Призраки и пометки под указателем: что встанет, выбранное, кисть, камера игрока.
local function marks(c, state)
	local input = c.input
	local x, y = math.floor(input.wx), math.floor(input.wy)
	-- Выбранное: юниты — кольцом, здания — рамкой.
	for _, e in controls.selection(c) do
		local at = c:get(e, "Position")
		if at then
			local mover = c:get(e, "Mover")
			local building = c:get(e, "Building")
			if mover then
				c.draw:circle(at.x, at.y, mover.radius + 0.2, SELECTED, 2, 0.9)
			elseif building then
				c.draw:rect(at.x - building.width / 2, at.y - building.height / 2, at.x + building.width / 2, at.y + building.height / 2, SELECTED, 2, 0.9)
			end
		end
	end
	for _, spot in controls.spots(c) do
		frame(c, spot.x, spot.y, spot.x + deposits.SIZE, spot.y + deposits.SIZE, MARK)
	end
	local box = cameraBox(c, state)
	if box then
		local arm = 12 / c.camera.zoom
		frame(c, box.left, box.top, box.right, box.bottom, MARK)
		c.draw:rect(box.view.x - arm, box.view.y - 1 / c.camera.zoom, box.view.x + arm, box.view.y + 1 / c.camera.zoom, MARK)
		c.draw:rect(box.view.x - 1 / c.camera.zoom, box.view.y - arm, box.view.x + 1 / c.camera.zoom, box.view.y + arm, MARK)
	end
	local held = dragging
	if held and held.kind == "box" then
		c.draw:rect(held.x, held.y, input.wx, input.wy, SELECTED, nil, 0.12)
		frame(c, held.x, held.y, input.wx, input.wy, SELECTED)
	end
	if not input.inside or input.over_ui then
		return
	end
	if state.tool == "paint" then
		local from = math.floor(state.size / 2)
		frame(c, x - from, y - from, x - from + state.size, y - from + state.size, MARK)
	elseif state.tool == "building" then
		local kind = c.protos.buildings[state.building]
		local left, top = x - math.floor(kind.data.width / 2), y - math.floor(kind.data.height / 2)
		local fits = placement.canPlace(c, kind, left, top)
		c:show(kind, placement.middle(left, kind.data.width), placement.middle(top, kind.data.height), { tint = if fits then GHOST else BLOCKED, over = true, player = state.player })
	elseif state.tool == "unit" then
		c:show(c.protos.units[state.unit], x + 0.5, y + 0.5, { tint = GHOST, over = true, player = state.player })
	elseif state.tool == "deposit" then
		local sx, sy = depositSpot(x, y)
		local fits = editor.canPutDeposit(c, sx, sy)
		c:show(c.protos.deposits[state.kind], sx + deposits.SIZE / 2, sy + deposits.SIZE / 2, { tint = if fits then GHOST else BLOCKED, over = true, player = 0 })
	end
end

function controls.update(c)
	local input = c.input
	local state = controls.state(c)
	if input.hits.delete or input.hits.backspace then
		controls.eraseSelection(c)
	end
	if input.hits.escape then
		state.ordering = false
	end
	if input.pressed.left and input.inside and not input.over_ui then
		pressed = { x = input.x, y = input.y, wx = input.wx, wy = input.wy }
		down(c, state, input.wx, input.wy, input.keys.shift)
	end
	if pressed and input.down.left then
		drag(c, state, input.wx, input.wy)
	end
	if pressed and input.released.left then
		pressed = nil
		up(c, state, input.wx, input.wy)
	end
	-- Правая — щелчок без сдвига (протяжка правой двигает камеру).
	if input.pressed.right and input.inside and not input.over_ui then
		state.right = { x = input.x, y = input.y }
	end
	if state.right and input.released.right then
		local still = math.abs(input.x - state.right.x) <= controls.data.threshold and math.abs(input.y - state.right.y) <= controls.data.threshold
		state.right = nil
		if still then
			secondary(c, state, input.wx, input.wy)
		end
	end
	marks(c, state)
end

return controls
