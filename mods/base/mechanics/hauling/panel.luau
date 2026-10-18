--!strict
-- Перевозки на панели: у своих грузовиков без строителей — режим работы и что возить, у хранилищ — резерв, у станций
-- запроса — заказ; в сведениях — кузов и работа грузовика, склад здания, материалы стройки и первого заказа.

local goods = require("lib/goods")
local logistics = require("lib/logistics")
local construction = require("lib/construction")
local panel = require("lib/panel")
local widgets = require("lib/widgets")
local world = require("lib/world")
local truckControls = require("controls/trucks")

local COLORS = widgets.COLORS
local goodWith, goodsRow = panel.goodWith, panel.goodsRow

-- Страницы сетки грузовиков, хранилищ и станций запроса (filter, reserve, request): key — выделение, для которого
-- открыта страница; deal — груз, заказ которого набирают.
local cargo: { key: string, page: string, deal: string? } = { key = "", page = "root", deal = nil }

-- Готовое и руда по порядку грузов.
local function waresOf(c): ({ string }, { string })
	local wares, ores = {}, {}
	for _, kind in goods.list(c) do
		table.insert(if kind.data.kind == "ore" then ores else wares, kind.name)
	end
	return wares, ores
end

-- Чем занят грузовик: carry, route, serve, mine, supply, pickup или auto.
local function jobOf(c, truck: number): string
	local hauler = c:get(truck, "Hauler")
	if c:has(truck, "Carry") then
		return "carry"
	elseif #hauler.route > 0 then
		return "route"
	elseif #hauler.serve > 0 then
		return "serve"
	elseif hauler.mine >= 0 then
		return "mine"
	elseif hauler.supply >= 0 then
		return "supply"
	elseif hauler.pickup >= 0 then
		return "pickup"
	end
	return "auto"
end

-- Открывает страницу для этого выделения; другое выделение — снова корень.
local function cargoPage(selection, name: string?)
	local key = table.concat(selection, ",")
	if cargo.key ~= key then
		cargo.key, cargo.page, cargo.deal = key, "root", nil
	end
	if name then
		cargo.page, cargo.deal = name, nil
	end
	return cargo.page
end

-- Сетка выбранных грузовиков: верхний ряд — режим работы, подсвечен тот, в котором грузовик; ниже — что возить.
local function truckSlots(c, list, selection, units: { number })
	local page = cargoPage(selection)
	local filter = c:get(units[1], "Hauler").filter or {}
	local job = jobOf(c, units[1])
	for _, truck in units do
		if jobOf(c, truck) ~= job then
			job = "mixed"
		end
	end
	local mode = c.shared.mode
	local kind = mode and mode.kind
	if page == "root" then
		list[1] = {
			label = c:t("grid.truckAuto"),
			active = job == "auto",
			title = c:t("grid.truckAutoTip"),
			run = function()
				c:send("serve", { units = units, buildings = {} })
			end,
		}
		local carrying = kind == "carrySource" or kind == "carryTarget"
		list[2] = {
			label = c:t("grid.carry"),
			active = job == "carry" or carrying,
			title = c:t("grid.carryTip"),
			run = function()
				c.shared.truckMenu = nil
				c.shared.mode = if carrying then nil else { kind = "carrySource" }
			end,
		}
		list[3] = {
			label = if kind == "routing" then c:t("grid.routeStops", { stops = #mode.stops }) else c:t("grid.route"),
			active = job == "route" or kind == "routing",
			title = c:t("grid.routeTip"),
			run = function()
				c.shared.mode = if kind == "routing" then nil else { kind = "routing", stops = {} }
			end,
		}
		list[4] = {
			label = if kind == "serving" then c:t("grid.serveCount", { count = #mode.buildings }) else c:t("grid.serve"),
			active = job == "serve" or kind == "serving",
			title = c:t("grid.serveTip"),
			run = function()
				c.shared.mode = if kind == "serving" then nil else { kind = "serving", buildings = {} }
			end,
		}
		list[5] = {
			label = if #filter > 0 then c:t("grid.filterCount", { count = #filter }) else c:t("grid.filter"),
			active = #filter > 0,
			title = c:t("grid.filterTip"),
			run = function()
				cargoPage(selection, "filter")
			end,
		}
		if #filter > 0 then
			list[6] = { label = c:t("grid.all"), title = c:t("grid.allTip"), run = function()
				c:send("filter", { units = units, goods = {} })
			end }
		end
	elseif page == "filter" then
		local wares, ores = waresOf(c)
		-- Руда в фильтре — вся сразу: по видам её различает месторождение, а не игрок.
		local function has(names: { string }): boolean
			for _, name in names do
				if not table.find(filter, name) then
					return false
				end
			end
			return true
		end
		local function toggle(names: { string })
			local nextFilter = {}
			if has(names) then
				for _, name in filter do
					if not table.find(names, name) then
						table.insert(nextFilter, name)
					end
				end
			else
				nextFilter = table.clone(filter)
				for _, name in names do
					if not table.find(nextFilter, name) then
						table.insert(nextFilter, name)
					end
				end
			end
			c:send("filter", { units = units, goods = nextFilter })
		end
		for i, ware in wares do
			if i >= panel.BACK - 1 then
				break
			end
			list[i] = { label = c:t(c.protos.goods[ware].data.title), picture = c.protos.goods[ware], active = has({ ware }), title = c:t("grid.carryOrNot"), run = function()
				toggle({ ware })
			end }
		end
		if #ores > 0 then
			list[math.min(#wares + 1, panel.BACK - 1)] = { label = c:t("grid.ore"), picture = c.protos.goods[ores[1]], active = has(ores), title = c:t("grid.oreTip"), run = function()
				toggle(ores)
			end }
		end
		panel.back(c, list, function()
			cargoPage(selection, "root")
		end)
	end
end

-- Резерв выбранных своих готовых хранилищ: сколько груза не выдавать; первое из них и наименьшая вместимость.
local function reserveSlots(c, list, selection)
	local buildings, amount, capacity = {}, 0, math.huge
	for _, e in selection do
		local stock = world.isReady(c, c.player, e) and logistics.isStore(c, e) and c:get(e, "Inventory")
		if stock then
			if #buildings == 0 then
				amount = stock.reserve or 0
			end
			table.insert(buildings, e)
			capacity = math.min(capacity, stock.capacity)
		end
	end
	if #buildings == 0 then
		return
	end
	local page = cargoPage(selection)
	local function set(value: number)
		c:send("reserve", { buildings = buildings, amount = math.max(0, math.min(capacity, value)) })
	end
	if page == "root" then
		list[1] = {
			label = if amount > 0 then c:t("grid.reserveCount", { amount = amount }) else c:t("grid.reserve"),
			active = amount > 0,
			title = c:t("grid.reserveTip"),
			run = function()
				cargoPage(selection, "reserve")
			end,
		}
	elseif page == "reserve" then
		-- Верхний ряд — прибавить, второй — убавить: по 10 и по 50.
		for i, step in { 10, 50 } do
			list[i] = { label = "+" .. step, disabled = amount >= capacity, title = c:t("grid.reserveCount", { amount = amount }), run = function()
				set(amount + step)
			end }
			list[i + 4] = { label = "−" .. step, disabled = amount <= 0, title = c:t("grid.reserveCount", { amount = amount }), run = function()
				set(amount - step)
			end }
		end
		list[3] = { label = c:t("grid.all"), active = amount >= capacity, title = c:t("grid.reserveAllTip"), run = function()
			set(capacity)
		end }
		list[panel.CANCEL] = { label = c:t("grid.reserveNone"), active = amount <= 0, title = c:t("grid.reserveNoneTip"), run = function()
			set(0)
		end }
		panel.back(c, list, function()
			cargoPage(selection, "root")
		end)
	end
end

-- Заказ выбранных своих станций запроса: какой груз и сколько держать; заказ первой из них и наименьшая вместимость.
local function requestSlots(c, list, selection)
	local buildings, wanted, capacity = {}, {}, math.huge
	for _, e in selection do
		local order = world.isReady(c, c.player, e) and c:get(e, "Wanted")
		local stock = order and c:get(e, "Inventory")
		if order and stock then
			if #buildings == 0 then
				wanted = order.items
			end
			table.insert(buildings, e)
			capacity = math.min(capacity, stock.capacity)
		end
	end
	if #buildings == 0 then
		return
	end
	local page = cargoPage(selection)
	local wares = waresOf(c)
	if page == "root" then
		local count = 0
		for _ in wanted do
			count += 1
		end
		list[1] = {
			label = if count > 0 then c:t("grid.requestCount", { count = count }) else c:t("grid.request"),
			active = count > 0,
			title = c:t("grid.requestTip"),
			run = function()
				cargoPage(selection, "request")
			end,
		}
	elseif page == "request" and not cargo.deal then
		-- Сначала — какой груз: ячейка на каждый, с заказанным количеством. Количество — на следующем шаге.
		for i, ware in wares do
			if i >= panel.BACK - 1 then
				break
			end
			local amount = wanted[ware] or 0
			local title = c:t(c.protos.goods[ware].data.title)
			list[i] = { label = if amount > 0 then title .. " ×" .. amount else title, picture = c.protos.goods[ware], active = amount > 0, title = c:t("grid.requestGoodTip"), run = function()
				cargo.deal = ware
			end }
		end
		panel.back(c, list, function()
			cargoPage(selection, "root")
		end)
	elseif page == "request" then
		-- Верхний ряд — прибавить, второй — убавить; «Всё» — сколько осталось места на складе за вычетом других заказов.
		local resource = cargo.deal :: string
		local amount = wanted[resource] or 0
		local others = 0
		for name, held in wanted do
			if name ~= resource then
				others += held
			end
		end
		local max = math.max(0, capacity - others)
		local function set(value: number)
			c:send("want", { buildings = buildings, resource = resource, amount = math.max(0, math.min(max, value)) })
		end
		local title = c:t("grid.requestAmount", { good = c:t(c.protos.goods[resource].data.title), amount = amount })
		local picture = c.protos.goods[resource]
		for i, step in { 10, 50 } do
			list[i] = { label = "+" .. step, picture = picture, disabled = amount >= max, title = title, run = function()
				set(amount + step)
			end }
			list[i + 4] = { label = "−" .. step, picture = picture, disabled = amount <= 0, title = title, run = function()
				set(amount - step)
			end }
		end
		list[3] = { label = c:t("grid.all"), active = amount >= max, title = "×" .. max, run = function()
			set(max)
		end }
		list[panel.CANCEL] = { label = c:t("grid.requestNone"), active = amount <= 0, title = c:t("grid.requestNoneTip"), run = function()
			set(0)
		end }
		panel.back(c, list, function()
			cargo.deal = nil
		end)
	end
end


-- Грузовики — режим и фильтр, иначе хранилища — резерв, станции запроса — заказ. Открытая страница этого выделения —
-- не корень.
local function slots(c, list, view)
	local selection = view.selection
	if #view.builders == 0 then
		local units = truckControls.selected(c)
		if #units > 0 then
			truckSlots(c, list, selection, units)
		else
			reserveSlots(c, list, selection)
			requestSlots(c, list, selection)
		end
	end
	if cargo.key == table.concat(selection, ",") and cargo.page ~= "root" then
		view.root = false
	end
end

-- Кузов и работа грузовика; склад готового здания (турели — у снабжения).
local function stock(c, view)
	local ui, first, kind, text = c.ui, view.first, view.kind, view.width
	local held = not view.many and c:mine(first) and c:get(first, "Inventory")
	local hauler = not view.many and c:get(first, "Hauler")
	if held and hauler then
		ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
			local before, after = widgets.split(c:t("hud.cargo", { capacity = held.capacity }), "items")
			ui:text((string.gsub(before, "%s+$", "")))
			goodsRow(c, held.items, c:t("common.empty"))
			ui:text((string.gsub(after, "^%s*(.-)[%s%.]*$", "%1")))
		end)
		local job
		local order = c:get(first, "Carry")
		local function titleOf(e: number): string
			local other = c:alive(e) and c:proto(e)
			return if other then c:t(other.data.title) else "?"
		end
		local function goodName(name: string): string
			local good = c.protos.goods[name]
			return if good then c:t(good.data.title) else name
		end
		if order then
			local left = math.ceil(order.left - 1e-6)
			job = if order.from >= 0
				then c:t("hud.job.carry", { name = goodName(order.resource), from = titleOf(order.from), to = titleOf(order.to), left = left })
				else c:t("hud.job.unload", { name = goodName(order.resource), to = titleOf(order.to), left = left })
		elseif #hauler.route > 0 then
			local names = {}
			for _, stop in hauler.route do
				table.insert(names, titleOf(stop))
			end
			job = c:t("hud.job.route", { stops = table.concat(names, " → ") })
		elseif #hauler.serve > 0 then
			local names = {}
			for _, building in hauler.serve do
				table.insert(names, titleOf(building))
			end
			job = c:t("hud.job.serve", { list = table.concat(names, ", ") })
		elseif hauler.supply >= 0 then
			job = c:t("hud.job.supply", { name = titleOf(hauler.supply) })
		elseif hauler.mine >= 0 then
			job = c:t("hud.job.mine")
		elseif hauler.pickup >= 0 then
			job = c:t("hud.job.pickup")
		elseif hauler.to >= 0 and c:alive(hauler.to) then
			local good = c.protos.goods[hauler.resource]
			local name = if good then c:t(good.data.title) else hauler.resource
			local left = math.floor(math.max(0, if hauler.full then goods.amount(held, hauler.resource) else hauler.amount))
			local toKind = c:proto(hauler.to)
			local fromKind = hauler.from >= 0 and c:alive(hauler.from) and c:proto(hauler.from)
			job = if fromKind and not hauler.full
				then c:t("hud.job.carry", { name = name, from = c:t(fromKind.data.title), to = c:t(toKind.data.title), left = left })
				else c:t("hud.job.unload", { name = name, to = c:t(toKind.data.title), left = left })
		else
			job = c:t("hud.job.auto")
		end
		ui:text(job, { color = COLORS.soft, wrap = text })
	elseif held and view.built and not kind.data.ammo then
		ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
			ui:text((if kind.data.stores then c:t("hud.storage") else c:t("hud.stock")) .. ":")
			goodsRow(c, held.items, c:t("common.empty"))
			ui:text((string.gsub(c:t("hud.holds", { capacity = held.capacity }), "^%s+", "")) .. (if (held.reserve or 0) > 0 then c:t("hud.reserve", { amount = held.reserve }) else ""), { color = COLORS.dim })
		end)
	end
end

-- Материалы стройки и первого заказа: сколько есть из нужного; ждут — подвоз.
local function materials(c, view)
	local ui, first, text = c.ui, view.first, view.width
	local needed = not view.many and c:mine(first) and logistics.materials(c, first)
	if not needed then
		return
	end
	local have = c:get(first, "Inventory")
	local waiting = if view.site then construction.awaitsMaterials(c, first) else next(logistics.missing(c, first)) ~= nil
	ui:box({ direction = "row", align = "center", gap = 6, width = text }, function()
		ui:text(c:t("hud.materials") .. ":", { color = if waiting then COLORS.warn else COLORS.soft })
		for _, name in goods.names(c) do
			if needed[name] then
				goodWith(c, name, if have then goods.amount(have, name) else 0, 20, needed[name])
			end
		end
	end)
	if waiting then
		ui:text(widgets.capital((string.gsub(c:t("hud.materialsWaiting"), "^[%s—]+", ""))), { color = COLORS.warn, wrap = text })
	end
end

return {
	slots = { { at = 40, fill = slots } },
	info = { { at = 100, draw = stock }, { at = 180, draw = materials } },
}
