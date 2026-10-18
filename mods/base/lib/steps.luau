--!strict
-- Первые шаги новичка вместо туториала — перенос packages/client/src/game/firstSteps.ts: список с галочками по
-- настоящей цепочке экономики. Шаг отмечается сам, по миру, а не по сценарию: есть готовое здание, открыта тема,
-- получена награда. Цепочка: MCV разворачивается в главное здание, оно выпускает строителя; электростанция даёт
-- энергию, генератор материи — первый доход; шахта ставится на металлическую руду, грузовик возит её руду в
-- лабораторию, лаборатория исследует плавку; тогда открывается плавильня, металл из неё нужно куда-то складывать —
-- иначе она забьётся и встанет; первый металл открывает космопорт, а продажа — главный доход.
--
-- У шага есть место на карте (target): где его делать. Кнопка «Показать» ведёт туда камеру, а на карте оно обведено
-- (effects/steps). Только клиенту: что игрок разведал, знает лишь он.

local construction = require("lib/construction")
local conversion = require("lib/conversion")
local research = require("lib/research")
local logistics = require("lib/logistics")
local depositsLib = require("lib/deposits")
local kinds = require("lib/kinds")

local steps = {}

export type Target = { x: number, y: number, width: number, height: number }

-- Шаги по порядку (STEPS): что подсветить, пока шаг текущий, — кнопку здания (и её раздел), заказ юнита,
-- разворот MCV, кнопку исследований или продажу у космопорта; название и что сделать (steps.items в ru.json).
steps.LIST = {
	{
		key = "deploy",
		deploy = true,
		title = "Разверни MCV",
		tip = "Выбери MCV и нажми «Развернуть», затем щёлкни по свободной скале: MCV доедет и станет главным зданием. Оно задаёт зону стройки, даёт доход и выпускает строителей.",
	},
	{
		key = "builder",
		unit = "builder",
		title = "Закажи строителя",
		tip = "Выбери главное здание и нажми «Строитель» в сетке справа. Строители возводят все здания и сами подвозят им материалы.",
	},
	{
		key = "generator",
		building = "generator",
		title = "Построй электростанцию",
		tip = "Выбери строителя → «Хозяйство» → «Электростанция» и щёлкни в зоне стройки рядом с главным зданием. Без энергии остальные здания работают медленнее или стоят.",
	},
	{
		key = "matter",
		building = "matter",
		title = "Построй генератор материи",
		tip = "Строитель → «Хозяйство» → «Генератор материи». Он сам приносит кредиты — первый доход базы — и берёт энергию у электростанции.",
	},
	{
		key = "mine",
		building = "mine",
		title = "Поставь шахту на металлическую руду",
		tip = "Нажми «Показать»: камера покажет ближайшее найденное месторождение металла, на карте оно обведено. Строитель → «Хозяйство» → «Шахта» — щёлкни прямо по нему. Не найдено ни одного — разведай округу багги.",
	},
	{
		key = "truck",
		unit = "truck",
		title = "Закажи грузовик",
		tip = "Выбери главное здание и нажми «Грузовик» в сетке справа. Грузовики возят руду с шахт в лаборатории и на переработку, а готовое — на склады, и сами берутся за заявки зон.",
	},
	{
		key = "lab",
		building = "lab",
		title = "Построй лабораторию у шахты",
		tip = "Строитель → «Хозяйство» → «Лаборатория» — рядом с шахтой: руду в неё привезут грузовики. Исследования открывают почти всё.",
	},
	{
		key = "metalOre",
		research = "metalOre",
		title = "Исследуй «Плавку металла»",
		tip = "Нажми «Исследования» на верхней полосе и выбери «Плавку металла». Лаборатория изучит её на металлической руде из шахты.",
	},
	{
		key = "smelter",
		building = "smelter",
		title = "Построй плавильню у шахты",
		tip = "Строитель → «Переработка» → «Плавильня» — рядом с шахтой: руду ей привезут грузовики, а из руды выйдет металл.",
	},
	{
		key = "metalYard",
		building = "metalYard",
		title = "Построй склад металла у плавильни",
		tip = "Строитель → «Склады» → «Склад металла» — рядом с плавильней: грузовики свезут туда металл. Без склада она забьётся металлом и встанет; отсюда же металл берут стройка и продажа.",
	},
	{
		key = "spaceport",
		building = "spaceport",
		title = "Построй космопорт",
		tip = "Строитель → «Хозяйство» → «Космопорт», лучше рядом со складом металла. Ему нужно 20 металла — строитель сам привезёт его со склада.",
	},
	{
		key = "sale",
		sell = true,
		title = "Продай металл",
		tip = "Выбери космопорт → «Продажа» → металл. Металл свезут в космопорт, корабль улетит с ним, и кредиты придут на счёт — это главный доход.",
	},
}

-- Как далеко от базы искать месторождение для первой шахты, в тайлах (DEPOSIT_SEARCH).
local DEPOSIT_SEARCH = 80
-- Как часто пересчитывать шаги и цель, в секундах (STEP_EVERY в cursorPass.ts).
local EVERY = 0.5

-- Есть ли у игрока свой юнит этого вида.
local function hasUnit(c, player: number, name: string): boolean
	for _, e in c:each({ "Unit", "Owner" }) do
		local kind = kinds.of(c, e)
		if kind and kind.name == name and c:get(e, "Owner").player == player then
			return true
		end
	end
	return false
end

-- Готовые шахты игрока на месторождениях этого вида.
local function minesOn(c, player: number, deposit: string): { number }
	local found = {}
	for _, e in c:each({ "Building", "Position" }) do
		local kind = kinds.of(c, e)
		if kind and kind.name == "mine" and construction.isReady(c, player, e) then
			local under = logistics.depositUnder(c, e)
			local spot = under and kinds.of(c, under)
			if spot and spot.name == deposit then
				table.insert(found, e)
			end
		end
	end
	return found
end

-- Какие шаги пройдены, по шагу (stepsDone). Пройденный дальше отмечает и все до него: строитель мог погибнуть, а
-- главное здание — свернуться в MCV, но новичку уже не надо учиться их заказывать и разворачивать.
function steps.done(c, player: number): { boolean }
	local state = research.player(c, player)
	local rewards = state and state.rewards or {}
	local function rewarded(key: string): boolean
		return table.find(rewards, key) ~= nil
	end
	local function built(name: string): boolean
		return #construction.missing(c, player, { name }) == 0
	end
	local met = {
		deploy = rewarded("deploy") or built(conversion.building(c).name),
		builder = hasUnit(c, player, "builder"),
		generator = rewarded("generator") or built("generator"),
		matter = rewarded("matter") or built("matter"),
		-- Шахта нужна на металле: на другой руде плавку не изучить.
		mine = #minesOn(c, player, "metal") > 0,
		truck = hasUnit(c, player, "truck"),
		-- Без дерева технологий темы открыты все — шаги о них пройдены сразу.
		lab = built("lab") or research.has(c, player, "science"),
		metalOre = research.has(c, player, "metalOre"),
		-- Торговля открывается первым готовым ресурсом — значит, плавильня уже поработала.
		smelter = built("smelter") or (construction.rules(c).techTree and research.has(c, player, "trade")),
		metalYard = rewarded("metalYard") or built("metalYard"),
		spaceport = built("spaceport"),
		sale = rewarded("sale"),
	}
	local done = {}
	for i, step in steps.LIST do
		done[i] = met[step.key] == true
	end
	for i = #done - 1, 1, -1 do
		done[i] = done[i] or done[i + 1]
	end
	return done
end

-- Текущий шаг — первый непройденный; nil — пройдены все.
function steps.current(done: { boolean })
	local i = table.find(done, false)
	return i and steps.LIST[i]
end

-- Своё здание этого вида — готовое или на стройке; nil — нет.
local function ownBuilding(c, player: number, name: string): number?
	local site = nil
	for _, e in c:each({ "Building", "Owner" }) do
		local kind = kinds.of(c, e)
		if kind and kind.name == name and c:get(e, "Owner").player == player then
			if not c:has(e, "Site") then
				return e
			end
			site = site or e
		end
	end
	return site
end

-- Основание здания как цель.
local function footprint(c, e: number?): Target?
	if not e or not c:get(e, "Position") then
		return nil
	end
	local size = c:get(e, "Building")
	local x, y = construction.corner(c, e)
	return { x = x, y = y, width = size.width, height = size.height }
end

-- Свой юнит этого вида как цель: тайл под ним и вокруг.
local function unitTarget(c, player: number, name: string): Target?
	for _, e in c:each({ "Unit", "Owner", "Position" }) do
		local kind = kinds.of(c, e)
		if kind and kind.name == name and c:get(e, "Owner").player == player then
			local at = c:get(e, "Position")
			return { x = math.floor(at.x) - 1, y = math.floor(at.y) - 1, width = 3, height = 3 }
		end
	end
	return nil
end

-- Знает ли игрок месторождение: разведан хоть тайл под ним (knowsDeposit).
local function knows(c, x: number, y: number): boolean
	for dy = 0, depositsLib.SIZE - 1 do
		for dx = 0, depositsLib.SIZE - 1 do
			if c:explored(x + dx + 0.5, y + dy + 0.5) then
				return true
			end
		end
	end
	return false
end

-- Ближайшее к базе известное игроку свободное месторождение этого вида, где ещё есть руда (nearestDeposit).
local function nearestDeposit(c, name: string, fromX: number, fromY: number): Target?
	local best, bestDistance = nil, math.huge
	local half = depositsLib.SIZE / 2
	for _, e in c:each({ "Deposit", "Position" }) do
		local kind = kinds.of(c, e)
		local at = c:get(e, "Position")
		local distance = math.sqrt((at.x - fromX) ^ 2 + (at.y - fromY) ^ 2)
		if not kind or kind.name ~= name or distance > DEPOSIT_SEARCH or distance >= bestDistance or c:get(e, "Deposit").reserve <= 0 then
			continue
		end
		local x, y = at.x - half, at.y - half
		if c:occupant(x, y) or not knows(c, x, y) then
			continue
		end
		best = { x = x, y = y, width = depositsLib.SIZE, height = depositsLib.SIZE }
		bestDistance = distance
	end
	return best
end

-- Где делать шаг (stepTarget): MCV — разворачивать, главное здание — заказывать строителя, грузовика и строиться
-- рядом, месторождение металла — ставить шахту, шахта на металле — ставить рядом лабораторию и плавильню,
-- плавильня — склад металла, склад — космопорт, космопорт — продавать. nil — показать нечего: исследование, или
-- нужное ещё не найдено.
function steps.target(c, player: number, key: string): Target?
	local core = footprint(c, ownBuilding(c, player, conversion.building(c).name))
	local mcv = conversion.unit(c).name
	if key == "deploy" then
		return unitTarget(c, player, mcv)
	elseif key == "builder" or key == "truck" or key == "generator" or key == "matter" then
		return core
	elseif key == "mine" then
		local base = core or unitTarget(c, player, mcv)
		return base and nearestDeposit(c, "metal", base.x + base.width / 2, base.y + base.height / 2)
	elseif key == "lab" or key == "smelter" then
		return footprint(c, minesOn(c, player, "metal")[1])
	elseif key == "metalOre" then
		return footprint(c, ownBuilding(c, player, "lab"))
	elseif key == "metalYard" then
		return footprint(c, ownBuilding(c, player, "smelter"))
	elseif key == "spaceport" then
		return footprint(c, ownBuilding(c, player, "metalYard")) or core
	elseif key == "sale" then
		return footprint(c, ownBuilding(c, player, "spaceport"))
	end
	return nil
end

-- Шаги своего игрока и цель текущего, пересчёт раз в EVERY секунд: их спрашивают панель, сетка и обводка на карте.
function steps.of(c): { done: { boolean }, step: any, target: Target? }
	local cached = c.shared.steps
	if cached and math.abs(c.time - cached.at) < EVERY then
		return cached
	end
	local done = steps.done(c, c.player)
	local step = steps.current(done)
	cached = { at = c.time, done = done, step = step, target = step and steps.target(c, c.player, step.key) }
	c.shared.steps = cached
	return cached
end

return steps
