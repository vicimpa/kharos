import { complete } from '../net/chatCommands'
import type { ComponentChildren } from 'preact'
import type { HudState, Stack } from '../game/hud'
import { MINIMAP_SIZE, type Minimap } from '../game/minimap'
import type { PaveTool } from '../game/scene'
import { buildingPortrait, pavePortrait, unitPortrait } from '../game/portraits'
import { goodIcon } from '../game/goodIcons'
import { useEffect, useRef, useState } from 'preact/hooks'
import { REWARDS, resourceOf, type UnitType, type BuildingType, type Command, type Good, type Reward } from '../sim'
import { GRID_KEYS, commandsOf, keyLabel, type Page, type Slot } from './commands'
import { BUILDING_NAMES, PRODUCT_NAMES, RESOURCE_NAMES, REWARD_NAMES, UNIT_NAMES, goodName } from './names'

interface HudProps {
  state: HudState
  send: (command: Command) => void
  /** Начать выбор места под здание; null — отменить. */
  place: (building: BuildingType | null) => void
  /** Начать укладку или снятие покрытия; null — отменить. */
  pave: (tool: PaveTool | null) => void
  /** Начать набор маршрута грузовикам; false — отменить. */
  route: (start: boolean) => void
  /** Начать выбор зданий, которые обслуживают грузовики; false — отменить. */
  serve: (start: boolean) => void
  /** Начать набор точек патруля бойцам; false — отменить. */
  patrol: (start: boolean) => void
  minimap: Minimap
  /** Камера в точку карты, в тайлах: сразу. */
  lookAt: (x: number, y: number) => void
  /** Камера летит к точке карты, в тайлах. */
  flyTo: (x: number, y: number) => void
  /** Камера на выделенное. */
  lookAtSelection: () => void
  /** Оставить в выделении только этот вид юнитов; remove — убрать его. */
  narrow: (type: UnitType, remove: boolean) => void
  /** Выделенных — в точку карты. */
  moveSelected: (x: number, y: number) => void
  /** Написать в чат сетевой игры. */
  say: (text: string) => void
  /** Кнопки меню справа на верхней полосе. */
  menu: ComponentChildren
}

const percent = (value: number) => `${Math.round(value * 100)}%`

/** Значок груза цвета груза и количество; название — во всплывающей подсказке. */
function Res({ resource, amount, of }: { resource: Good; amount?: number; of?: number }) {
  return (
    <span class="hud__res" data-tip={goodName(resource)}>
      <img src={goodIcon(resource)} alt="" />
      {amount !== undefined && (of !== undefined ? `${amount}/${of}` : amount)}
    </span>
  )
}

/** Ресурсы в строку. */
const Stacks = ({ items }: { items: Stack[] }) => (
  <>
    {items.map(({ resource, amount }) => (
      <Res key={resource} resource={resource} amount={amount} />
    ))}
  </>
)

/** Полоса готовности с подписью. */
const Progress = ({ value, children }: { value: number; children: ComponentChildren }) => (
  <div class="hud__progress">
    <span style={{ width: percent(value) }} />
    <em>{children}</em>
  </div>
)

/**
 * Подсказка для всего, у чего есть data-tip: появляется сразу у курсора, а не через секунду, как системная,
 * и не обрезается краями ячеек и прокручиваемых блоков.
 */
function Tip() {
  const [tip, setTip] = useState<{ text: string; card: string | null; x: number; y: number } | null>(null)
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const owner = event.target instanceof Element ? event.target.closest('[data-tip]') : null
      const text = owner?.getAttribute('data-tip')
      setTip(text ? { text, card: owner!.getAttribute('data-card'), x: event.clientX, y: event.clientY } : null)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])
  if (!tip) return null
  // Карточка берётся из CARDS при каждой отрисовке: цена и доступность в ней свежие, пока курсор стоит на месте.
  const card = tip.card !== null ? CARDS.get(tip.card) : undefined
  if (card) {
    // Карточка — над сеткой команд, правым краем у курсора: сетка у правого края экрана.
    return (
      <div class="hud tip tip--card" style={{ right: `${Math.max(8, window.innerWidth - tip.x - 40)}px`, bottom: `${window.innerHeight - tip.y + 24}px` }}>
        {card}
      </div>
    )
  }
  // Над курсором, а у верхнего края — под ним; у правого края — левее курсора.
  const below = tip.y < 60
  const left = tip.x > window.innerWidth - 260
  return (
    <div
      class="hud tip"
      style={{
        left: left ? undefined : `${tip.x + 14}px`,
        right: left ? `${window.innerWidth - tip.x + 14}px` : undefined,
        top: `${below ? tip.y + 20 : tip.y - 36}px`,
      }}
    >
      {tip.text}
    </div>
  )
}

/** Сколько секунд сообщение о награде висит на экране. */
const TOAST_SECONDS = 5

/**
 * Награды, полученные только что: каждая показывается TOAST_SECONDS. Те, что были до входа в игру, не показываются:
 * пока мир не пришёл от хоста (loaded), всё, что в нём есть, считается уже виденным.
 */
function useNewRewards(rewards: string[], loaded: boolean) {
  const seen = useRef(rewards.length)
  /** Был ли мир уже загружен при прошлой проверке: в обновлении, где он пришёл, все его награды — старые. */
  const ready = useRef(false)
  const [fresh, setFresh] = useState<string[]>([])
  useEffect(() => {
    const added = ready.current ? rewards.slice(seen.current) : []
    ready.current = loaded
    // Список стал короче — мир начался заново: считаем с нуля.
    seen.current = rewards.length
    if (!added.length) return
    setFresh((list) => [...list, ...added])
    // Таймер не отменяется при следующей награде: иначе прежнее сообщение осталось бы висеть.
    setTimeout(() => setFresh((list) => list.filter((key) => !added.includes(key))), TOAST_SECONDS * 1000)
  }, [rewards.length, loaded])
  return fresh
}

/**
 * Мини-карта: перерисовывается каждый кадр. Левая кнопка (и протяжка) ставит туда камеру, правая — посылает
 * туда выделенных.
 */
/** Сколько секунд сообщение чата видно, пока чат закрыт, и сколько из них оно гаснет. */
const CHAT_SHOWN = 10
const CHAT_FADE = 1
/** Сколько последних сообщений видно в закрытом чате. */
const CHAT_RECENT = 8

/**
 * Чат, как в Minecraft: Enter открывает строку ввода, Enter отправляет, Escape закрывает. Закрытый чат показывает
 * свежие сообщения, и через CHAT_SHOWN секунд они гаснут; открытый — всю историю.
 */
/** Сколько подсказок дополнения видно над строкой чата. */
const CHAT_SUGGESTIONS = 6

interface ChatProps {
  lines: NonNullable<HudState['chat']>
  picking: boolean
  commands: HudState['commands']
  admin: boolean
  names: string[]
  say: (text: string) => void
}

function Chat({ lines, picking, commands, admin, names, say }: ChatProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  /** Строка чата спрашивает пароль администратора: набранное скрыто и уходит как /admin <пароль>. */
  const [password, setPassword] = useState(false)
  /** Какая подсказка дополнения выбрана стрелками. */
  const [chosen, setChosen] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const pickingRef = useRef(picking)
  pickingRef.current = picking
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.repeat || pickingRef.current) return
      // «/» открывает чат сразу с началом команды; на русской раскладке та же клавиша — точка.
      const slash = event.key === '/' || event.code === 'Slash' || event.code === 'NumpadDivide'
      if (event.code !== 'Enter' && event.code !== 'NumpadEnter' && !slash) return
      event.preventDefault()
      if (slash) setDraft('/')
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  const close = () => {
    setOpen(false)
    setDraft('')
    setPassword(false)
    setChosen(0)
    input.current?.blur()
  }
  const suggestions = password ? [] : complete(draft, commands, names).slice(0, CHAT_SUGGESTIONS)
  const pick = Math.min(chosen, suggestions.length - 1)
  const edit = (text: string) => {
    setDraft(text)
    setChosen(0)
  }
  const now = performance.now()
  const shown = open ? lines : lines.slice(-CHAT_RECENT).filter((line) => now - line.at < CHAT_SHOWN * 1000)
  if (!open && !shown.length) return null
  return (
    <div class={`hud chat${open ? ' is-open' : ''}`}>
      <div class="chat__lines">
        {shown.map((line, i) => {
          const left = CHAT_SHOWN - (now - line.at) / 1000
          return (
            <div key={i} class={`chat__line${line.system ? ' is-system' : ''}`} style={open ? undefined : { opacity: Math.min(1, left / CHAT_FADE) }}>
              {line.system ? (
                line.name ? `${line.name} ${line.text}` : line.text
              ) : line.whisper ? (
                <i class="chat__whisper">
                  &lt;{line.name} → {line.whisper}&gt; {line.text}
                </i>
              ) : (
                <>
                  <b class={line.own ? 'is-own' : undefined}>&lt;{line.name}&gt;</b> {line.text}
                </>
              )}
            </div>
          )
        })}
      </div>
      {open && suggestions.length > 0 && (
        <div class="chat__suggestions">
          {suggestions.map((item, i) => (
            <div
              key={item.text + item.label}
              class={`chat__suggestion${i === pick ? ' is-chosen' : ''}`}
              // До blur строки: иначе чат закроется раньше, чем подсказка подставится.
              onMouseDown={(event) => {
                event.preventDefault()
                edit(item.text)
              }}
            >
              <b>{item.label}</b> <span>{item.help}</span>
            </div>
          ))}
        </div>
      )}
      {open && (
        <input
          ref={input}
          class={`chat__input${admin ? ' is-admin' : ''}`}
          // Типы Preact не дают выбрать type выражением: "text" и "password" у них в разных перегрузках.
          type={(password ? 'password' : 'text') as 'password'}
          placeholder={password ? 'Пароль администратора' : admin ? 'режим администратора' : undefined}
          value={draft}
          maxLength={200}
          onInput={(event) => edit(event.currentTarget.value)}
          onBlur={close}
          onKeyDown={(event) => {
            // Клавиши чата не доходят ни до игры, ни до сетки команд.
            event.stopPropagation()
            if (event.code === 'Escape') close()
            if (event.code === 'Tab') {
              event.preventDefault()
              if (suggestions[pick]) edit(suggestions[pick].text)
            }
            if ((event.code === 'ArrowUp' || event.code === 'ArrowDown') && suggestions.length) {
              event.preventDefault()
              const step = event.code === 'ArrowUp' ? -1 : 1
              setChosen((pick + step + suggestions.length) % suggestions.length)
            }
            if (event.code === 'Enter' || event.code === 'NumpadEnter') {
              // Голый /admin спрашивает пароль отдельно, скрытым полем: в строке чата его видно.
              // Команда с паролем — /admin — спрашивает его скрытым полем; набранное после неё в строке не уходит.
              const secret = commands.find((command) => command.secret && draft.trim().toLowerCase().split(' ')[0] === `/${command.name}`)
              if (!password && secret) {
                setPassword(true)
                setDraft('')
                return
              }
              if (password) {
                if (draft) say(`/admin ${draft}`)
              } else if (draft.trim()) say(draft)
              close()
            }
          }}
        />
      )}
    </div>
  )
}

function MinimapView({ minimap, lookAt, moveSelected }: Pick<HudProps, 'minimap' | 'lookAt' | 'moveSelected'>) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const context = ref.current!.getContext('2d')!
    let frame = requestAnimationFrame(function draw() {
      minimap.draw(context)
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [minimap])

  const tileOf = (event: PointerEvent) => {
    const box = ref.current!.getBoundingClientRect()
    const u = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    const v = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
    return minimap.tileAt(u, v)
  }
  return (
    <canvas
      ref={ref}
      class="bar__minimap"
      width={MINIMAP_SIZE}
      height={MINIMAP_SIZE}
      onPointerDown={(event) => {
        const { x, y } = tileOf(event)
        if (event.button === 2) return moveSelected(x, y)
        if (event.button !== 0) return
        ref.current!.setPointerCapture(event.pointerId)
        lookAt(x, y)
      }}
      onPointerMove={(event) => {
        if (!(event.buttons & 1)) return
        const { x, y } = tileOf(event)
        lookAt(x, y)
      }}
      onContextMenu={(event) => event.preventDefault()}
    />
  )
}

/** Картинка ячейки: портрет здания или юнита, значок груза или покрытия, или ничего. */
function SlotImage({ slot }: { slot: Slot }) {
  if (slot.building) return <img src={buildingPortrait(slot.building)} alt="" />
  if (slot.unit) return <img src={unitPortrait(slot.unit)} alt="" />
  if (slot.good) return <img class="bar__good" src={goodIcon(slot.good)} alt="" />
  if (slot.pave) return <img src={pavePortrait(slot.pave)} alt="" />
  return null
}

/** Карточки ячеек сетки для подсказки: ячейка кладёт сюда свою при каждой отрисовке, подсказка находит её по data-card. */
const CARDS = new Map<string, ComponentChildren>()

/** Карточка ячейки: название с клавишей, пояснение, полная цена и энергия. */
function SlotCard({ slot, hotkey }: { slot: Slot; hotkey: string }) {
  const price = slot.cost !== undefined || slot.materials?.length || slot.power
  return (
    <div class="card">
      <div class="card__title">
        {slot.label} <kbd>{hotkey}</kbd>
      </div>
      {slot.about && <div class="card__text">{slot.about}</div>}
      {slot.title && <div class={slot.about && slot.disabled ? 'card__text is-warn' : 'card__text'}>{slot.title}</div>}
      {price ? (
        <div class="card__price">
          {slot.cost !== undefined && (
            <span class={slot.gain ? 'card__credits is-gain' : 'card__credits'}>
              <span class="hud__coin" />
              {slot.gain ? `+${slot.cost}` : slot.cost}
            </span>
          )}
          {slot.materials?.length ? <Stacks items={slot.materials} /> : null}
          {slot.power ? <span class="hud__power">⚡{slot.power > 0 ? `+${slot.power}` : slot.power}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Сетка команд 4×3: ячейка — кнопка со своей клавишей. */
function CommandGrid({ slots }: { slots: (Slot | null)[] }) {
  return (
    <div class="bar__grid">
      {slots.map((slot, i) => {
        const key = keyLabel(GRID_KEYS[i])
        if (!slot) return <div key={i} class="bar__cell bar__cell--empty" />
        CARDS.set(String(i), <SlotCard slot={slot} hotkey={key} />)
        return (
          <button
            key={i}
            class={['bar__cell', slot.group !== undefined && 'bar__cell--group', slot.active && 'is-active'].filter(Boolean).join(' ')}
            disabled={slot.disabled}
            data-tip={slot.label}
            data-card={String(i)}
            onClick={slot.run}
          >
            <SlotImage slot={slot} />
            <kbd>{key}</kbd>
            {slot.group !== undefined && <span class="bar__count">{slot.group}</span>}
            <span class="bar__label">{slot.group !== undefined ? `${slot.label} ▸` : slot.label}</span>
            {/* В ячейке — только кредиты: полная цена с ресурсами и энергией — в карточке при наведении. */}
            <span class="bar__price">
              {slot.cost !== undefined && <b class={slot.gain ? 'is-gain' : undefined}>{slot.gain ? `+${slot.cost}` : slot.cost}</b>}
              {slot.cost === undefined && slot.materials?.length ? <small>…</small> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Сведения о выбранном: портрет, название, прочность и всё, что здание или отряд делает сейчас. */
function Info({ state, lookAtSelection, narrow }: { state: HudState; lookAtSelection: () => void; narrow: HudProps['narrow'] }) {
  const { units, building, deposit, site, construction, conversion, production, assembly, trade } = state
  const many = units.length > 1 || (units[0]?.count ?? 0) > 1
  const health = building !== null ? (state.health ?? 1) : (state.army?.health ?? 1)

  const title =
    building !== null
      ? state.buildings > 1
        ? state.mixed ? `Зданий: ${state.buildings}` : `${BUILDING_NAMES[building]} ×${state.buildings}`
        : `${site ? (site.demolish ? 'Разбор: ' : 'Стройка: ') : ''}${BUILDING_NAMES[building]}`
      : units.map(({ type, count }) => (count > 1 ? `${UNIT_NAMES[type]} ×${count}` : UNIT_NAMES[type])).join(', ')

  return (
    <div class="bar__info">
      {many ? (
        <div class="bar__units">
          {units.map(({ type, count }) => (
            <button
              key={type}
              class="bar__unit"
              data-tip={`${UNIT_NAMES[type]}: щелчок — оставить только их, Shift — убрать из выделения`}
              onClick={(event) => narrow(type, event.shiftKey)}
            >
              <img src={unitPortrait(type)} alt="" />
              {count > 1 && <b>{count}</b>}
            </button>
          ))}
        </div>
      ) : (
        <button class="bar__portrait" data-tip="Показать на карте" onClick={lookAtSelection}>
          <img src={building !== null ? buildingPortrait(building) : unitPortrait(units[0].type)} alt="" />
          <span class="bar__health" style={{ width: percent(health) }} data-low={health < 0.35 || undefined} />
        </button>
      )}

      <div class="bar__details">
        <header class="hud__title">{title}</header>

        {state.power && (
          <div class={state.power.demand > state.power.produced ? 'hud__hint hud__power is-short' : 'hud__hint hud__power'}>
            ⚡ Энергия зоны: потребляется {state.power.demand} из {state.power.produced}
            {state.power.demand > state.power.produced && ' — перегруз, станции разрушаются'}
          </div>
        )}
        {state.coreless && <div class="hud__hint is-short">Денег не приносит: в зоне нет главного здания</div>}
        {state.unlinked && <div class="hud__hint is-short">Не подключено к сети: протяни трубу — без этого ресурсы не придут и не уйдут</div>}
        {state.starved && <div class="hud__hint hud__power is-short">⚡ Не хватает энергии: здание работает медленнее или стоит</div>}
        {state.switchable && !state.switchable.on && <div class="hud__hint is-short">Выключено: энергию не берёт и не работает; включи в сетке справа</div>}
        {state.health !== null && (
          <div class="hud__hint">Прочность: {percent(state.health)}. Починка стоит {state.repair}: выбери строителей и щёлкни по зданию правой кнопкой</div>
        )}
        {state.army && state.army.health < 1 && <div class="hud__hint">Прочность: {percent(state.army.health)}. Технику чинят строители, пехота поправляется сама</div>}
        {state.army && state.army.armed > 0 && !construction && (
          <div class="hud__hint">Сами стреляют по врагам в пределах выстрела. Правый щелчок по врагу — атаковать</div>
        )}

        {state.stored?.slots && (
          <div class="hud__hint">
            Склад:{' '}
            {state.stored.slots.map(({ resource, amount, of }) => (
              <Res key={resource} resource={resource} amount={amount} of={of} />
            ))}
          </div>
        )}
        {state.stored && !state.stored.slots && (
          <div class="hud__hint">
            {state.stored.buffer ? 'Материалы заказа' : state.stored.store ? 'Хранилище' : 'Склад'}: <Stacks items={state.stored.items} />
            {state.stored.items.length === 0 && 'пусто'}
            {!state.stored.buffer && ` — вмещает ${state.stored.capacity}`}
          </div>
        )}
        {state.refinery && (
          <div class="hud__hint">
            Перерабатывает <Res resource={state.refinery.ore} /> {goodName(state.refinery.ore).toLowerCase()} в{' '}
            <Res resource={resourceOf(state.refinery.ore)} /> {goodName(resourceOf(state.refinery.ore)).toLowerCase()},{' '}
            {state.refinery.intake} в секунду. Руду везут грузовики из шахт и харвестеры, готовое свободные грузовики развозят
            по хранилищам
          </div>
        )}
        {state.harvest && (
          <div class="hud__hint">
            {state.harvest.kind ? (
              <>
                Копает <Res resource={state.harvest.kind} /> {goodName(state.harvest.kind).toLowerCase()} и везёт на переработку.{' '}
              </>
            ) : state.harvest.parked ? (
              'Стоит и ждёт команды. '
            ) : state.harvest.seek && state.harvest.seek !== 'any' ? (
              <>
                Ищет <Res resource={state.harvest.seek} /> {goodName(state.harvest.seek).toLowerCase()}: среди найденных, а нет — разведывает.{' '}
              </>
            ) : (
              'Ищет месторождение: среди найденных, а нет — разведывает. '
            )}
            Правый щелчок по найденному месторождению — копать там
          </div>
        )}
        {state.ammo && (
          <div class={state.ammo.have <= 0 ? 'hud__hint is-short' : 'hud__hint'}>
            Боеприпасы: <Res resource="ammo" amount={state.ammo.have} of={state.ammo.capacity} />
            {state.ammo.have <= 0 ? ' — пусто, турель молчит, пока не подвезут' : '. Расстреляет четверть — грузовики подвезут из хранилищ зоны'}
          </div>
        )}
        {assembly && (
          <>
            <div class="hud__hint">
              <Stacks items={assembly.inputs} /> → <Res resource={assembly.recipe} amount={assembly.yield} /> за {assembly.seconds} с
            </div>
            <Progress value={assembly.progress}>
              {PRODUCT_NAMES[assembly.recipe]} в зоне: {assembly.have} —{' '}
              {!assembly.on
                ? assembly.progress > 0
                  ? 'выключен, доделывает сборку'
                  : 'выключен'
                : assembly.progress > 0
                  ? 'собирает'
                  : assembly.full
                    ? 'хранилища полны, ждёт'
                    : 'ждёт сырья'}
            </Progress>
            {!assembly.on && <div class="hud__hint is-short">Завод выключен: включи его в сетке справа</div>}
          </>
        )}
        {state.materials && (
          <div class={state.materials.waiting ? 'hud__hint is-short' : 'hud__hint'}>
            Материалы:{' '}
            {state.materials.items.map(({ resource, have, need }) => (
              <Res key={resource} resource={resource} amount={have} of={need} />
            ))}
            {state.materials.waiting && ' — ждёт подвоза из хранилищ зоны'}
          </div>
        )}
        {state.cargo && (
          <div class="hud__hint">
            Груз: <Stacks items={state.cargo.items} />
            {state.cargo.items.length === 0 && 'пусто'} из {state.cargo.capacity}.{' '}
            {state.haul?.routing !== null && state.haul?.routing !== undefined
              ? `Набор маршрута: остановок ${state.haul.routing}. Щёлкай по своим зданиям со складом; правая кнопка или Enter — готово, Esc — отмена`
              : state.haul?.serving !== null && state.haul?.serving !== undefined
              ? `Выбор зданий: ${state.haul.serving}. Щёлкай по своим зданиям, повторный щелчок убирает; правая кнопка или Enter — готово, Esc — отмена`
              : state.cargo.bound > 0
              ? 'Возит руду из шахты на переработку'
              : state.haul && state.haul.served > 0
                ? 'Обслуживает назначенные здания: возит только по их заявкам, груз берёт в любой своей зоне'
              : state.haul && state.haul.routed > 0
                ? 'Ездит по маршруту: на каждой остановке сгружает, что там принимают, и берёт для следующей'
              : state.cargo.busy > 0
                ? 'Везёт по заявке зоны'
                : 'Свободен: сам берёт заявки зон. Правый щелчок по шахте — возить только из неё'}
          </div>
        )}
        {trade &&
          (trade.order ? (
            <Progress value={trade.order.flight ?? trade.order.delivered / trade.order.wanted}>
              {trade.order.buy
                ? `Закупка летит: ${RESOURCE_NAMES[trade.order.resource].toLowerCase()} ×${trade.order.wanted}, оплачено ${trade.order.wanted * trade.order.price}`
                : trade.order.flight !== null
                ? `Корабль в пути: ${RESOURCE_NAMES[trade.order.resource].toLowerCase()} ×${trade.order.wanted} за ${trade.order.wanted * trade.order.price}`
                : `Грузовики везут ${RESOURCE_NAMES[trade.order.resource].toLowerCase()}: ${trade.order.delivered} из ${trade.order.wanted}`}
            </Progress>
          ) : (
            <div class="hud__hint">
              {trade.offers.length ? 'Продажа из хранилищ зоны: верхний ряд — по 50, второй — всё' : 'Продавать нечего: хранилища зоны пусты'}.
              Закупка с орбиты — втрое дороже продажи, привезённое грузовики развезут по хранилищам
            </div>
          ))}
        {deposit && (
          <div class="hud__hint">
            <Res resource={deposit.kind} /> {RESOURCE_NAMES[deposit.kind]}: {deposit.left > 0 ? `осталось ${deposit.left}` : 'месторождение выработано'}
          </div>
        )}
        {site && (
          <Progress value={site.progress}>
            {site.demolish
              ? site.progress < 1
                ? `Разбирается — осталось ${percent(site.progress)}`
                : 'Ждёт строителя: выбери его и щёлкни по зданию правой кнопкой'
              : site.started
                ? `Строится — ${percent(site.progress)}`
                : site.blocked
                  ? 'Место занято юнитами'
                  : 'Ждёт строителя'}
          </Progress>
        )}
        {conversion && conversion.progress !== null && (
          <Progress value={conversion.progress}>
            {conversion.blocked ? 'Место занято юнитами' : conversion.kind === 'deploy' ? 'Разворачивается' : 'Сворачивается'}
          </Progress>
        )}
        {production && production.queue.length > 0 && (
          <>
            <Progress value={production.progress}>{UNIT_NAMES[production.queue[0]]}</Progress>
            <div class="bar__queue">
              {production.queue.map((unit, i) => (
                <img key={i} src={unitPortrait(unit)} alt={UNIT_NAMES[unit]} data-tip={UNIT_NAMES[unit]} />
              ))}
            </div>
          </>
        )}
        {production?.building && (
          <div class="hud__hint">
            {production.rally ? 'Готовые едут к флажку; правый щелчок по карте — перенести' : 'Правый щелчок по карте — точка сбора готовых'}
          </div>
        )}
        {state.tactics?.picking && (
          <div class="hud__hint">Щелчок — патруль до точки; Shift+щелчок — ещё точка к патрулю; правая кнопка или Esc — отмена</div>
        )}
        {construction?.paving && (
          <div class="hud__hint">
            {construction.paving.tool === 'remove' ? 'Тяни левой кнопкой, что снять' : `Тяни левой кнопкой: ${construction.paving.tiles} тайл., ${construction.paving.cost} кредитов${construction.paving.short ? `; на ${construction.paving.short} тайл. не хватает кредитов (жёлтые)` : ''}`}; правая или Esc — хватит
          </div>
        )}
        {construction && !construction.placing && !construction.paving && (
          <div class="hud__hint">Строит здания и чинит своё: правый щелчок по стройке или повреждённому. Здания — в сетке справа</div>
        )}
        {construction?.placing && <div class="hud__hint">Левая кнопка — заложить, можно ещё и ещё; правая или Esc — хватит</div>}
      </div>
    </div>
  )
}

/** Интерфейс игрока: верхняя полоса со счётом и нижняя панель — мини-карта, выбранное, сетка команд. */
export function Hud({ state, send, place, pave, route, serve, patrol, minimap, lookAt, flyTo, lookAtSelection, narrow, moveSelected, say, menu }: HudProps) {
  const selected = state.units.length > 0 || state.building !== null
  const fresh = useNewRewards(state.rewards, state.loaded)

  // Страница сетки строителя сбрасывается, когда выбрано другое.
  const [page, setPage] = useState<Page>('root')
  const selectionKey = `${state.building}:${state.units.map(({ type, count }) => `${type}${count}`).join()}`
  useEffect(() => setPage(state.construction?.placing || state.construction?.paving ? page : 'root'), [selectionKey])

  const slots = selected ? commandsOf(state, page, { send, place, pave, route, serve, patrol, open: setPage }) : []

  // Клавиши сетки. Читаются из ref, чтобы не переподписываться на каждое обновление.
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      const i = (GRID_KEYS as readonly string[]).indexOf(event.code)
      const slot = i >= 0 ? slotsRef.current[i] : null
      if (!slot || slot.disabled) return
      event.preventDefault()
      slot.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Список игроков сервера — пока зажат Tab.
  const [roster, setRoster] = useState(false)
  useEffect(() => {
    const toggle = (shown: boolean) => (event: KeyboardEvent) => {
      if (event.code !== 'Tab' || event.target instanceof HTMLInputElement) return
      event.preventDefault()
      setRoster(shown)
    }
    const down = toggle(true)
    const up = toggle(false)
    const hide = () => setRoster(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', hide)
    }
  }, [])

  return (
    <>
      {roster && state.players.length > 0 && (
        <section class="hud roster" aria-label="Игроки">
          <h2>Игроки · {state.players.filter(({ online }) => online).length} в сети</h2>
          <ul>
            {state.players.map(({ name, own, online }) => (
              <li class={own ? 'is-own' : online ? undefined : 'is-away'}>
                <span>{name}</span>
                <small>{own ? 'вы' : online ? 'в сети' : 'не в сети'}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      <header class="hud hud--top">
        <span class="hud--credits" data-tip="Кредиты">
          <span class="hud__coin" />
          {state.credits}
          {state.income > 0 && <small>+{state.income}/с</small>}
        </span>
        {state.stock && (
          <span class="hud__stock" data-tip={`Запас в хранилищах; всего помещается ${state.stock.capacity}`}>
            <Stacks items={state.stock.items} />
            {state.stock.items.length === 0 && <span class="hud__res">хранилища пусты</span>}
          </span>
        )}
        <span class="hud__clock" data-tip={state.storm ? 'Время суток; идёт непогода' : 'Время суток'}>
          {state.clock}
          {state.storm && ' · непогода'}
        </span>
        <span class="hud__menu">{menu}</span>
      </header>

      <Tip />
      {state.chat && <Chat
          lines={state.chat}
          picking={state.picking}
          commands={state.commands}
          admin={state.admin}
          names={state.players.map((player) => player.name)}
          say={say}
        />}
      {state.hover && (
        <div class="hud tip" style={{ left: `${state.hover.x + 16}px`, top: `${state.hover.y + 16}px` }}>
          <Res resource={state.hover.kind} /> Месторождение: {RESOURCE_NAMES[state.hover.kind].toLowerCase()}
          <small>{state.hover.left === null ? 'остаток неизвестен' : state.hover.left > 0 ? `осталось ${state.hover.left}` : 'выработано'}</small>
        </div>
      )}

      {state.pipeHover && (
        <div class="hud tip" style={{ left: `${state.pipeHover.x + 16}px`, top: `${state.pipeHover.y + 16}px` }}>
          Сеть: зданий {state.pipeHover.buildings}
          <small>
            {state.pipeHover.stock.length
              ? state.pipeHover.stock.map(({ resource, amount }) => <Res key={resource} resource={resource} amount={amount} />)
              : state.pipeHover.capacity ? 'хранилища пусты' : 'хранилищ нет'}
          </small>
        </div>
      )}

      {state.alerts.length > 0 && !state.editor && (
        <div class="hud hud--alerts" role="status">
          {state.alerts.map(({ kind, text, x, y, at }) => (
            <button key={at} class={`hud__alert is-${kind}`} data-tip="Показать место" onClick={() => flyTo(x, y)}>
              {text}
            </button>
          ))}
        </div>
      )}

      {fresh.length > 0 && (
        <div class="hud hud--rewards">
          {fresh.map((key) => (
            <div key={key} class="hud__reward">
              <span class="hud__coin" />
              <strong>+{REWARDS[key as Reward]}</strong> {REWARD_NAMES[key as Reward]}
            </div>
          ))}
        </div>
      )}

      {/* В редакторе справа его панель: от нижней остаётся только мини-карта. */}
      <section class={`hud bar${state.editor ? ' is-editor' : ''}`}>
        <MinimapView minimap={minimap} lookAt={lookAt} moveSelected={moveSelected} />
        {state.editor ? null : selected ? (
          <Info state={state} lookAtSelection={lookAtSelection} narrow={narrow} />
        ) : (
          <div class="bar__info bar__info--empty">
            Ничего не выбрано. Левая кнопка — выбрать, рамка — несколько юнитов, правая — приказ. Ctrl+цифра — запомнить
            группу, цифра — выбрать её
          </div>
        )}
        {!state.editor && <CommandGrid slots={selected ? slots : Array(GRID_KEYS.length).fill(null)} />}
      </section>
    </>
  )
}
