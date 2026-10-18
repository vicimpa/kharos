# Моды: формат и API

Справочник мододела: как устроен мод, что отдаёт вид и что движок даёт скриптам. Зачем так — `docs/content.md`.
Образец — мод `mods/base`: это и есть игра Kharos.

## Мод

Мод — папка в `mods/`. В корне — `mod.luau`, остальное — разделы: папка первого уровня — раздел, в нём вид — файл
`имя.luau` или папка `имя/` с `init.luau`. Папка `lib/` — не раздел, а общий код для `require`.

```luau
-- mods/extra/mod.luau
return {
	title = "Ещё юниты",
	version = "0.1.0",
	requires = { "base" },        -- раньше этого мода; "?имя" — необязательная зависимость
	game = "skirmish",            -- партия по умолчанию (games/), последний мод главнее
	menu = "menu",                -- партия главного меню: в неё приложение приходит при запуске
	patch = function(protos)      -- после загрузки всех модов, в их порядке
		protos.units.buggy.data.speed = 5
		protos.moves.hover = nil
	end,
}
```

Картинки мода (`.png`) лежат где угодно в его папке; облик берёт их полем `image` (ниже).

Порядок модов — зависимости раньше, при равенстве по имени. Вид с тем же именем из более позднего мода заменяет
прежний. `patch` правит, добавляет и убирает чужие виды — то, что у Factorio `data-updates`.

`require("lib/geom")` — от корня своего мода, `require("./look")` — от папки файла, `require("@base/lib/geom")` — из
другого мода. Модуль выполняется один раз; вид, взятый `require`, — та же таблица, что в `protos`.

Глобальные таблицы только для чтения (песочница): без этого `math` и `buffer` медленнее в 16 раз. Глобальная `SIDE` —
`"host"` или `"client"`.

## Вид

Файл вида возвращает таблицу. Движок сам вписывает в неё `name`, `section`, `id` (номер, одинаковый у всех с теми же
модами) и `source`. Остальное — по договорённости разделов; что читает движок:

| Поле | Сторона | Что это |
|---|---|---|
| `data` | обе | числа и строки вида: скорость, цена, размер |
| `components` | хост | объявления компонентов (ниже) |
| `entity` | хост | из чего сделана сущность вида: таблица или функция от вида |
| `systems` | хост | системы над столбцами |
| `on` | хост | обработчики событий |
| `commands` | хост | приказы игроков |
| `look` | клиент | облик: чертёж, огни, звук |

Хост и клиент выполняют одни и те же файлы, каждый в своей машине, и берут свои поля. Чтобы правки данных другими
модами доходили до всего, пишите `entity` функцией и обращайтесь к данным через таблицу вида:

```luau
local buggy = {}
buggy.data = { speed = 4, turn = 3 }
buggy.entity = function(kind)
	return { Position = {}, Facing = {}, Owner = {}, Drive = { move = "wheels", speed = kind.data.speed } }
end
return buggy
```

## Хост

### Компоненты

```luau
components = {
	Drive = { move = "", speed = 0, turn = 0, tx = 0, ty = 0, moving = false },
	Producer = { unit = "", progress = 0, queue = {} },
}
```

Вид поля — по значению по умолчанию: число, флаг (`true`/`false`), строка, таблица. Числа, флаги и строки лежат
столбцами f64 (строка — номером, `ctx:id` и `ctx:text`); таблица — значение целиком, только через `ctx:get`/`ctx:set`.
Один компонент можно объявлять в нескольких видах: поля складываются.

Компоненты движка: `Position { x, y }` (центр, в тайлах), `Facing { angle }`, `Owner { player }`, `Proto { id }`
(вид сущности; ставится сам при `ctx:spawn`).

### Системы

```luau
systems = {
	drive = {
		query = { "Position", "Facing", "Drive" },  -- сущности со всеми этими компонентами
		where = { Drive = { move = "wheels" } },    -- и с такими значениями полей (числа, флаги, строки)
		write = { "Position", "Facing", "Drive" },  -- чьи столбцы после системы вернуть в мир
		every = 1,                                  -- раз в сколько тиков
		after = "income", before = { "fight" },     -- ключ системы или полное имя "moves/wheels.drive"
		run = function(q, ctx, kind)
			for i = 0, q.n - 1 do
				local at = i * 8
				local x = buffer.readf64(q.Position.x, at)
				buffer.writef64(q.Position.x, at, x + ctx.dt)
			end
		end,
	},
}
```

`q.n` — сколько сущностей, `q.entity` — их номера, `q.Компонент.поле` — буфер f64 на каждое числовое поле. Писать
можно в любой буфер, в мир вернутся только компоненты из `write`. Порядок систем — по `after`/`before`, иначе по
номерам видов. Время каждой системы по частям — `Host::timings`.

Замер (`cargo run -p kharos-world --release --example bench [юнитов]`, Apple Silicon): 10 тыс. багги на колёсах с новой
целью доехавшему — 0,9 мс на тик, из них Luau ходовой — 0,49, сборка и возврат столбцов — 0,37; 100 тыс. — 8,9 мс.
С расталкиванием (`mechanics/crowd`) — 2,1 и 34 мс.

### ctx

| | |
|---|---|
| `ctx.tick`, `ctx.dt` | номер тика и его длина в секундах |
| `ctx.storage` | память модов: обычная таблица, уходит в сохранение |
| `ctx.protos`, `ctx.game` | все виды по разделам; вид идущей партии |
| `ctx:spawn(вид, поля?)` | новая сущность: `"units/buggy"`, таблица вида или номер; `nil` — без вида. Поля — `{ Position = { x = 1 } }` поверх `entity`. Номер — сразу |
| `ctx:destroy(e)`, `ctx:add(e, К, поля?)`, `ctx:set(e, К, поля)`, `ctx:remove(e, К)` | изменения — после системы, по порядку |
| `ctx:get(e, К)`, `ctx:has(e, К)`, `ctx:alive(e)` | мир сейчас (буферы идущей системы сюда ещё не вернулись) |
| `ctx:query({ К… })` | та же таблица столбцов, на чтение |
| `ctx:near(x, y, r, { К… }?)` | сущности с Position в круге, по номерам |
| `ctx:count(К)` | сколько сущностей с компонентом |
| `ctx:id(строка)`, `ctx:text(номер)` | номер строки для сравнения со столбцом и обратно |
| `ctx:proto(вид)` | таблица вида по номеру или `"раздел/имя"` |
| `ctx:emit(имя, данные?)` | событие видам: `on[имя](ctx, данные)` после системы |
| `ctx:signal(имя, данные?)` | сигнал клиентам: звук, вспышка, сообщение |
| `ctx:random()`, `ctx:random(n)`, `ctx:random(a, b)` | случайное, одинаковое у всех, кто считает тот же мир |
| `ctx:separate(q, сила?)` | пакетный инструмент: расталкивает сущности запроса по `Unit.radius`, пишет в `q.Position` |

Пакетные инструменты — то, что горячо над тысячами сущностей: движок делает это над буферами запроса, а система,
которая решает, когда и кого, остаётся контентом. `ctx:separate` на 10 тыс. юнитов — 1,2 мс.

### События и приказы

`on = { имя = function(ctx, данные) end }`. События движка: `start { game }` — начало партии, `player_joined { player }`, `spawned { entity, proto }` — сущность
появилась (proto — номер вида или nil).

`commands = { имя = function(ctx, игрок, аргументы) end }` — приказ игрока, выполняется в начале тика. Проверять
аргументы и права — дело обработчика: приходит что угодно.

### Партия

Вид из `games/` — что такое партия. Правила (`systems`, `on`, `commands`) берутся только у идущей партии; `start(ctx,
партия)` — в начале. `client` — что берёт подача: камера, управление, панели, атмосфера, эффекты, звук, музыка (имена
видов своих разделов).

Главное меню — тоже партия (`menu` в mod.luau): мир под окнами и панель меню. Новую партию начинает
`c.app:start(партия, настройки)`: настройки ложатся в `data` партии поверх её значений у хоста и у клиента. Движок
сам читает из `data`: `size` (карта от −size до size), `fog`, `land` (вид `lands/`), `seed` и `generator` (правки
генератора местности поверх данных вида земли); остальное — для контента (у `base`: `name`, `weather`).

## Клиент

Клиент (`apps/client`, `cargo run -p kharos-client --release`) выполняет те же файлы в своей машине и берёт подачу.
Мир он видит только на чтение, менять может только приказом. Свою память скрипт держит в локальных переменных модуля:
машина клиента одна на игрока.

Порядок кадра: сигналы хоста → `signals` видов; камера; панели (`ui/`); управление (`controls/`); эффекты
(`effects/` — что живёт только на экране: колея, пыль); атмосфера; звук; музыка. Что берётся — решает партия:

```luau
skirmish.client = {
	camera = "rts",                 -- cameras/rts.luau
	controls = { "select", "orders" },
	ui = { "hud" },
	atmosphere = { "weather" },
	effects = { "traces" },         -- effects/traces.luau: update(c) раз в кадр
	music = "drift",
	teams = { own = { 0x1f63d8, 0x5aa9ff, 0xe4f4ff }, foe = { … }, ally = { … } },  -- тёмный, основной, светлый
}
```

### Облик

```luau
look = {
	size = 32,                    -- кадр в пикселях: число или { w, h }
	origin = { 16, 16 },          -- начало координат чертежа в кадре (по умолчанию — центр)
	anchor = { 0, 0 },            -- точка чертежа на месте сущности (у зданий — центр основания)
	directions = 64, phases = 4,
	step = 1 / 16,                -- кадр хода — по пройденному пути (тайлов на кадр); без step — fps по времени
	fps = 8,
	layer = "ground",             -- "ground", "building" (по нижнему краю), "air"; турель — слоем выше носителя
	shadow = { 2, 0.4 },          -- сдвиг тени в пикселях и её сила
	draw = function(canvas, angle, phase) … end,
	portrait = { size = 32, draw = function(canvas) … end },  -- для панелей: обрезается и вписывается
	lights = { lamps = { { вдоль, поперёк, радиус } }, beam = { along, length, near, spread, level } },
	image = "images/logo.png",    -- картинка из мода вместо чертежа: гладкая, для интерфейса (size — до какого уменьшить)
	sound = { voice = "motor", gain = 0.5, control = function(knobs, unit, c) … end },
	traces = { sides = { -4.5, 4.5 }, width = 3, legs = false },  -- колея (effects/traces): где и какой ширины, в пикселях
}
```

Чертёж выполняется при загрузке на каждое направление и фазу; кадры всех обликов пакуются в один атлас. Холст
(`canvas`) — тот же, что `Pixmap` в TS, поэтому чертежи из TS переносятся дословно и совпадают до пикселя
(`tools/art/check.sh`): `rect(x, y, w, h, цвет)` — от угла, `circle(x, y, r, цвет)`, `ring(x, y, r, толщина, цвет)`,
`line(ax, ay, bx, by, толщина, цвет)` — с прямыми торцами, `poly({ x1, y1, … }, цвет)`, `pixel(x, y, цвет)`,
`canvas.toned(цвет, тон)` — цвет стороны (тон 0, 1, 2 перекрашивает палитра), `translate(dx, dy)`,
`light(x, y, радиус, яркость)` — огонь кадра (здания). Цвет — `0xRRGGBB`.

Чертежи и помощники Kharos — `lib/units.luau` (перенос `unitArt.ts`: все юниты и турели, `units.look(вид,
крепления)`) и `lib/buildings.luau` (`buildingArt.ts`: `slab`, `dome`, `tower`, `lamp`, `bulb`, `buildings.look(w, h,
чертёж)`).

### c

| | |
|---|---|
| `c.input` | `x`, `y` — экран; `wx`, `wy` — мир; `down`, `pressed`, `released` — по `left`, `right`, `middle`; `wheel`; `keys` — зажатые (`"a"`, `"1"`, `"shift"`, `"left"`, `"escape"`); `hits` — нажатые за кадр; `text`; `over_ui`; `touch`; `focused`; `inside` |
| `c.camera` | `x`, `y` — центр в тайлах, `zoom` — пикселей на тайл |
| `c.screen` | `w`, `h` в логических пикселях |
| `c.shared` | общая память скриптов клиента (`selection` — выделенное) |
| `c.atmosphere` | что пишет атмосфера: `light` 0..1 (оттенок — `lightTint` из TS), `wind = { x, y }`, `precipitation` 0..1, `hour` |
| `c.music` | `mood`, `volume` |
| `c.time`, `c.dt`, `c.tick`, `c.clock` (секунды игры), `c.player`, `c.protos`, `c.game` | |
| `c:each`, `c:get`, `c:has`, `c:alive`, `c:proto(e)`, `c:mine(e)` | мир; `Position` и `Facing` сглажены между тиками |
| `c:pick(x, y)`, `c:within(x1, y1, x2, y2, { К… }?)` | сущность под точкой мира, сущности в прямоугольнике |
| `c:to_screen`, `c:to_world`, `c.hash(x, y, сид)` | `hash` — тот же, что у генератора местности |
| `c:send(приказ, аргументы)`, `c:sound(голос, { x, y, gain, pitch, bus }?)`, `c:particle({ … })` | |
| `c:decal({ from = { x, y }, to = { x, y }, width, color, opacity, density, life })` | след на земле (decalsPass.ts): отрезок и ширина в тайлах, цвет `0xRRGGBB` или `{ r, g, b }` 0..1; под юнитами, ночью темнеет с землёй; `density` — доля закрашенных пикселей, с четверти `life` растворяется пиксель за пикселем; вне обзора забывается; разом — до 12000 |
| `c:terrain(x, y)` | вид местности (0 болото, 1 песок, 2 скала, 3 гора) и биом |
| `c.draw:line/circle/rect(…, цвет, толщина?, альфа?)` | поверх мира, в тайлах; толщина — в пикселях |
| `c.ui` | интерфейс (ниже) |

### Интерфейс

`c.ui` — перенос `gui/ui.ts`, тот же API: панели описываются каждый кадр, движок раскладывает их (как flex) и рисует
рамками скина и Ark Pixel.

```luau
ui:box({ id = "top", anchor = { left = 0, right = 0, top = 0 }, height = 38, skin = "panel", padding = { 4, 12 },
	direction = "row", align = "center", gap = 12 }, function()
	ui:image("coin", 16, 16)
	ui:text("1000", { font = "title", color = "#f0c95a", shadow = "#0b111b", lift = 2 })
	ui:space(0, 0, 1)
	if ui:button("menu", { height = 30 }, function() ui:text("Меню") end) then … end
	ui:tip("menu", "Меню игры")
end)
```

Стиль узла: `id`, `direction` (`row`, `column`, `stack`), `self`, `gap`, `padding`, `align`, `justify` (`between`),
`width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `grow`, `shrink`, `wrap`, `skin` (`panel`,
`well`, `button…`, `gold`, `danger`), `background`, `outline`, `alpha`, `clip`, `scroll`, `anchor` (`left`, `right`,
`top`, `bottom`, `centerX`, `centerY`), `passive`. Текст: `font` (`body`, `small`, `title`, `logo`), `color`,
`shadow`, `lift`, `wrap`, `ellipsis`. Цвет — `"#rrggbb"`, `"rgb(r g b / a)"` или число.

`ui:image(вид | "coin" | "minimap", w, h, сторона?)` — портрет вида, вписанный в w × h (облик-картинка — гладко); `ui:button(id, стиль, дети)`
→ щелчок `{ button, shift, ctrl, alt, long }` или nil (`active`, `disabled` в стиле); `ui:clicked`, `ui:hovered`,
`ui:within`, `ui:held` (→ `{ u, v }`), `ui:tip(id, текст или функция, { left, right, top, bottom }?)` (функция строит панель узлами — карточка; без привязки — у указателя), `ui:rect(id)`, `ui:measure(текст, шрифт?)`, `ui.width`,
`ui.height`. Щелчок приходит кадром позже — по местам узлов прошлого кадра; долгое касание — правый щелчок.

`ui:input(id, значение, { width, placeholder, maxLength, digits, password, focus, color, background, outline })` —
поле ввода (`input` в ui.ts) → `{ value, focused, keys }`: набранное, в фокусе ли, клавиши, которые поле отдало
панели (`"Enter"`, `"Escape"`, `"Tab"`, `"ArrowUp"`, `"ArrowDown"`, `"Blur"`). Пока поле в фокусе, клавиши
достаются ему, а не игре (`c.input.typing`). `ui:preview(вид земли, правки генератора, сид, сторона карты, w, h)` —
схема будущей карты (preview.ts): считается порциями по кадрам → `{ ready, rock, swamp }`. `ui:upper(текст)` —
прописными с кириллицей. Поля меню (окно, кнопка, ползунок, флажок, варианты, числовое поле, раскрывающийся блок,
ссылка) — `lib/form.luau` мода `base`, перенос `gui/form.ts`.

`c.app` — приложение: `c.app:start(партия, настройки)`, `c.app:to_menu()`, `c.app:quit()`, `c.app:open(адрес)` —
ссылка в браузере; `c.app.game`, `c.app.menu`, `c.app.options` — идущая партия, партия меню и настройки партии.

### Звук

Как в TS-клиенте (`packages/client/src/audio`): сэмплы звуков считает Luau один раз при загрузке, а Web Audio их
играет. Виды раздела `sounds/` дают банк записей и голоса:

```luau
return {
	-- Банк: запись — буфер f32 (моно) или таблица буферов (стерео), вариантов несколько — звучат вразнобой.
	bank = {
		click = { bus = "interface", variants = 3, render = function(rate, variant) return dsp.render(…) end },
	},
	-- Голос: граф узлов и его ручки (как у motorVoice.ts). s.args — что передал тот, кто заводит голос.
	graph = function(s)
		local idle = s:sample("motor:" .. s.args.motor .. ":idle", { loop = true })
		local tone = s:filter("lowpass", 500, 0.7)
		idle:to(tone):to(s:out())
		return { idle = idle, tone = tone }
	end,
	update = function(n, knobs) n.idle.rate:glide(knobs.rate, 0.06) end,
}
```

Синтез — `lib/dsp.luau` (перенос `synth.ts`: `random`, `lowpass`, `highpass`, `bandpass`, `render`, `loop`,
`noiseLoop`, `reverbImpulse`); звуки Kharos — `sounds/synth.luau`, `sounds/motors.luau`, `sounds/world.luau`.

Узлы голоса: `osc(волна, частота)`, `noise(цвет)`, `sample(запись, { loop, offset, variant })`, `reverb(запись)`,
`const(v)`, `filter(вид, частота, q)`, `gain(v)`, `delay(время)`, `shape(сила)`, `pan(v)`, `lfo(частота, размах)`,
`env({ attack, decay, sustain, release, peak })`, `out()`; `a:to(b)` — и с параметром, и с узлом другого голоса.
Параметр: `узел.частота = v`, `:set(v, когда?)`, `:ramp(v, когда)`, `:exp(v, когда)`, `:target(v, когда, tau)`,
`:glide(v, tau)`; у записи — `rate`.

Что и когда звучит, решают скрипты раздела `audio/` (`update(c)` раз в кадр; партия выбирает их в `client.audio`):

| | |
|---|---|
| `c:sound(запись, { x, y, volume, reach, detune })` | разовый звук: в мире — тише вдали и в своей стороне (`hearing.ts`) |
| `c.audio:play(запись, громкость, сторона?, скорость?)` | разовый звук как есть; не больше 32 разом |
| `c.audio:loop(запись, громкость, сторона)` | фоновая петля: громкость и сторона меняются плавно |
| `c.audio:voice(вид или { graph, update }, { bus, into, at, length, note, velocity, args })` | свой голос: `set(ручки)`, `place(громкость, сторона)`, `release(секунды)`, `nodes` |
| `c:nearness(x, y, reach?)`, `c:side(x)`, `c.audio.now`, `c.audio:volume(группа, v)` | |
| `c.ui.pressed`, `c.ui.hovered_button` | нажали кнопку (`"click"` или `"deny"`), навели на неё — для звука интерфейса |

Группы громкости: `battle`, `world`, `interface`, `music`; на выходе компрессор. `KHAROS_AUDIO_LEVEL=1` печатает
уровень на выходе — проверить, что звук есть, не слушая.

Скрипты Kharos: `audio/interface` (кнопки, выделение), `audio/motors` (моторы с моделью езды `lib/drive.luau` —
стартер, передачи, холостые, толпа), `audio/machines` (работа зданий), `audio/ambience` (фон: ветер, гулы, шорох,
подложка в миноре, даль сквозь эхо), `audio/flight` (ветер полёта камеры).
