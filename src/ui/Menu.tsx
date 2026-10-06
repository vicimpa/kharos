import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { loadMuted, storeMuted } from '../audio/audio'
import { createSlot, deleteSave, exportSave, importSave, listSaves, renameSave, type SaveSlot } from '../game/storage'
import { DEFAULT_SETTINGS } from '../map/settings'
import { DEFAULT_CONFIG, type GeneratorConfig } from '../map/terrain'
import { DEFAULT_WEATHER } from '../sim'
import { GENERATOR_GROUPS, Groups } from './GeneratorPanel'
import { NAME_LENGTH, cleanName } from '../net/protocol'
import { forgetServer, lastLaunch, localServerUrl, recentServers, type Launch } from './launch'
import { MapPreview } from './MapPreview'

/** Симуляция идёт 20 тиков в секунду. */
const TICKS_PER_SECOND = 20
/** Какой стороны бывает карта новой игры, в тайлах. */
const MAP_SIZES = [512, 1024, 2048]
/** Сколько длятся сутки новой игры, в секундах; 0 — время стоит. */
const DAY_LENGTHS = [
  { seconds: 600, label: '10 мин' },
  { seconds: 1200, label: '20 мин' },
  { seconds: 2400, label: '40 мин' },
  { seconds: 0, label: 'Стоят' },
]
const clock = (hour: number) => `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`
const SERVER_KEY = 'kharos.server'

type Screen = 'main' | 'new' | 'saves' | 'network' | 'settings'

interface MenuProps {
  panel: boolean
  setPanel(panel: boolean): void
  play(launch: Launch): void
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 31)

const playtime = (tick: number) => {
  const minutes = Math.floor(tick / TICKS_PER_SECOND / 60)
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}

const date = (time: number) => new Date(time).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function loadServer() {
  try {
    const saved = JSON.parse(localStorage.getItem(SERVER_KEY) ?? 'null') as { url?: unknown; lag?: unknown; name?: unknown } | null
    return {
      url: typeof saved?.url === 'string' ? saved.url : localServerUrl(),
      lag: typeof saved?.lag === 'number' ? saved.lag : 0,
      name: typeof saved?.name === 'string' ? saved.name : '',
    }
  } catch {
    return { url: localServerUrl(), lag: 0, name: '' }
  }
}

/** Отдаёт браузеру файл на скачивание. */
function download(name: string, text: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/** Окно меню: заголовок, содержимое и кнопка «Назад», если это не главный экран. */
function Window({ title, back, children, wide }: { title: string; back?: () => void; children: ComponentChildren; wide?: boolean }) {
  return (
    <section class={wide ? 'menu__window menu__window--wide' : 'menu__window'}>
      <h2 class="menu__title">{title}</h2>
      {children}
      {back && (
        <div class="menu__footer">
          <button onClick={back}>Назад</button>
        </div>
      )}
    </section>
  )
}

/**
 * Главное меню поверх слайдов симуляции: продолжить последнюю игру, начать новую, загрузить сохранение, подключиться
 * к серверу, настроить игру.
 */
export function Menu({ panel, setPanel, play }: MenuProps) {
  const [screen, setScreen] = useState<Screen>('main')
  const [saves, setSaves] = useState(listSaves)
  const refresh = () => setSaves(listSaves())
  const home = () => setScreen('main')
  const [last] = useState(lastLaunch)
  const lastTitle = !last ? undefined : last.kind === 'save' ? `${last.slot.name} — ${playtime(last.slot.tick)}` : last.kind === 'server' ? `Сервер ${last.url}` : undefined

  return (
    <div class="menu">
      <h1 class="menu__logo">KHAROS</h1>
      {screen === 'main' && (
        <Window title="Главное меню">
          <nav class="menu__list">
            <button disabled={!last} title={lastTitle} onClick={() => last && play(last)}>
              Продолжить
            </button>
            <button onClick={() => setScreen('new')}>Новая игра</button>
            <button
              onClick={() => {
                refresh()
                setScreen('saves')
              }}
            >
              Сохранения
            </button>
            <button onClick={() => setScreen('network')}>Сетевая игра</button>
            <button onClick={() => setScreen('settings')}>Настройки</button>
          </nav>
        </Window>
      )}
      {screen === 'new' && <NewGame back={home} play={play} count={saves.length} />}
      {screen === 'saves' && <Saves back={home} saves={saves} refresh={refresh} play={play} />}
      {screen === 'network' && <Network back={home} play={play} />}
      {screen === 'settings' && <Settings back={home} panel={panel} setPanel={setPanel} />}
    </div>
  )
}

/** Ползунок местности для человека: t от 0 до 1 переводится в параметр генератора и обратно. */
interface Knob {
  key: keyof GeneratorConfig
  label: string
  title: string
  from: number
  to: number
}

const KNOBS: Knob[] = [
  // Чем ниже уровень скал, тем их больше: ползунок «больше» вправо.
  {
    key: 'rockLevel',
    label: 'Скалы',
    title: 'Сколько скал: на них строят, на них лежит руда',
    from: 0.75,
    to: 0.45,
  },
  {
    key: 'swampLevel',
    label: 'Болота',
    title: 'Сколько болот: по ним не проехать',
    from: 0.2,
    to: 0.5,
  },
  {
    key: 'zoneScale',
    label: 'Размер зон',
    title: 'Крупные плато и пустыни или мелкая мозаика',
    from: 24,
    to: 120,
  },
  {
    key: 'zoneWarp',
    label: 'Изрезанность',
    title: 'Округлые пятна или рваные края',
    from: 0,
    to: 80,
  },
  {
    key: 'biomeScale',
    label: 'Размер биомов',
    title: 'Как далеко тянутся солончаки, красные пустоши и топи',
    from: 80,
    to: 600,
  },
  {
    key: 'peakChance',
    label: 'Горы',
    title: 'Сколько гор на скалах: сквозь них не проехать и не построить',
    from: 0,
    to: 1,
  },
]

/** Готовые местности: отличия от генератора по умолчанию. */
const PRESETS: { label: string; generator: Partial<GeneratorConfig> }[] = [
  { label: 'Обычная', generator: {} },
  {
    label: 'Скалистая',
    generator: { rockLevel: 0.5, swampLevel: 0.3, peakChance: 0.5 },
  },
  {
    label: 'Пустыня',
    generator: { rockLevel: 0.68, swampLevel: 0.25, zoneScale: 80 },
  },
  {
    label: 'Болота',
    generator: { rockLevel: 0.62, swampLevel: 0.46, zoneWarp: 50 },
  },
  {
    label: 'Острова',
    generator: { rockLevel: 0.6, swampLevel: 0.5, zoneScale: 40, zoneWarp: 10 },
  },
]

const knobValue = (knob: Knob, config: GeneratorConfig) => Math.max(0, Math.min(1, ((config[knob.key] as number) - knob.from) / (knob.to - knob.from)))

/** Отличия местности от генератора по умолчанию, без зерна: их и хранит слот. */
function generatorChanges(config: GeneratorConfig) {
  const changes: Partial<GeneratorConfig> = {}
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof GeneratorConfig)[]) if (key !== 'seed' && config[key] !== DEFAULT_CONFIG[key]) changes[key] = config[key]
  return changes
}

function NewGame({ back, play, count }: { back(): void; play(launch: Launch): void; count: number }) {
  const [name, setName] = useState(`Игра ${count + 1}`)
  const [size, setSize] = useState(DEFAULT_SETTINGS.world.size)
  const [weather, setWeather] = useState(DEFAULT_WEATHER)
  const [generator, setGenerator] = useState<GeneratorConfig>(() => ({
    ...DEFAULT_CONFIG,
    seed: randomSeed(),
  }))
  const setSeed = (seed: number) => setGenerator({ ...generator, seed })
  const preset = PRESETS.find((preset) => {
    const changes = generatorChanges(generator)
    return Object.keys(changes).length === Object.keys(preset.generator).length && Object.entries(preset.generator).every(([key, value]) => changes[key as keyof GeneratorConfig] === value)
  })
  return (
    <Window title="Новая игра" back={back} wide>
      <form
        class="menu__setup"
        onSubmit={(event) => {
          event.preventDefault()
          const changes = generatorChanges(generator)
          play({
            kind: 'save',
            slot: createSlot(name.trim() || `Игра ${count + 1}`, size, generator.seed, weather, Object.keys(changes).length ? changes : undefined),
          })
        }}
      >
        <div class="menu__form">
          <label class="menu__field">
            <span>Название</span>
            <input value={name} maxLength={40} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <label class="menu__field">
            <span>Зерно карты</span>
            <span class="menu__inline">
              <input type="number" value={generator.seed} onInput={(event) => setSeed(Math.floor(Number(event.currentTarget.value)) || 0)} />
              <button type="button" title="Другая случайная местность с теми же настройками" onClick={() => setSeed(randomSeed())}>
                Случайно
              </button>
            </span>
          </label>
          <div class="menu__field">
            <span>Размер карты</span>
            <span class="menu__inline">
              {MAP_SIZES.map((option) => (
                <button type="button" key={option} class={option === size ? 'is-active' : undefined} onClick={() => setSize(option)}>
                  {option}
                </button>
              ))}
            </span>
          </div>
          <div class="menu__field">
            <span>Местность</span>
            <span class="menu__inline">
              {PRESETS.map((option) => (
                <button
                  type="button"
                  key={option.label}
                  class={option === preset ? 'is-active' : undefined}
                  onClick={() =>
                    setGenerator({
                      ...DEFAULT_CONFIG,
                      ...option.generator,
                      seed: generator.seed,
                    })
                  }
                >
                  {option.label}
                </button>
              ))}
            </span>
          </div>
          {KNOBS.map((knob) => (
            <label key={knob.key} class="menu__field menu__field--slider" title={knob.title}>
              <span>{knob.label}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={knobValue(knob, generator)}
                onInput={(event) => {
                  const value = knob.from + Number(event.currentTarget.value) * (knob.to - knob.from)
                  setGenerator({
                    ...generator,
                    [knob.key]: Math.round(value * 1000) / 1000,
                  })
                }}
              />
              <output>{Math.round(knobValue(knob, generator) * 100)}</output>
            </label>
          ))}
          <details class="menu__more">
            <summary>Тонкая настройка местности</summary>
            <Groups groups={GENERATOR_GROUPS} values={generator} onChange={setGenerator} />
          </details>
          <div class="menu__field">
            <span>Сутки длятся</span>
            <span class="menu__inline">
              {DAY_LENGTHS.map(({ seconds, label }) => (
                <button type="button" key={seconds} class={seconds === weather.dayLength ? 'is-active' : undefined} onClick={() => setWeather({ ...weather, dayLength: seconds })}>
                  {label}
                </button>
              ))}
            </span>
          </div>
          <label class="menu__field menu__field--slider">
            <span>Начальное время</span>
            <input
              type="range"
              min={0}
              max={23.5}
              step={0.5}
              value={weather.startHour}
              onInput={(event) =>
                setWeather({
                  ...weather,
                  startHour: Number(event.currentTarget.value),
                })
              }
            />
            <output>{clock(weather.startHour)}</output>
          </label>
          <label class="menu__check">
            <input type="checkbox" checked={weather.changes} onChange={(event) => setWeather({ ...weather, changes: event.currentTarget.checked })} />
            Погода меняется: ветер, дожди и бури
          </label>
        </div>
        <div class="menu__aside">
          <MapPreview config={generator} size={size} />
          <button type="submit" class="menu__primary">
            Начать
          </button>
        </div>
      </form>
    </Window>
  )
}

function Saves({ back, saves, refresh, play }: { back(): void; saves: SaveSlot[]; refresh(): void; play(launch: Launch): void }) {
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const pick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        importSave(JSON.parse(await file.text()))
        setError('')
      } catch (reason) {
        setError(reason instanceof SyntaxError ? 'Файл повреждён' : reason instanceof Error ? reason.message : String(reason))
      }
      refresh()
    }
    input.click()
  }
  return (
    <Window title="Сохранения" back={back} wide>
      {saves.length === 0 && <p class="menu__note">Сохранений нет. Начните новую игру или загрузите файл.</p>}
      <ul class="menu__saves">
        {saves.map((slot) => (
          <li key={slot.id} class="menu__save">
            <div class="menu__save-info">
              <strong>{slot.name}</strong>
              <small>
                {date(slot.updated)} · {playtime(slot.tick)} · карта {slot.size} · зерно {slot.seed}
              </small>
            </div>
            <span class="menu__inline">
              <button class="menu__primary" onClick={() => play({ kind: 'save', slot })}>
                Играть
              </button>
              <button
                onClick={() => {
                  const name = prompt('Новое название', slot.name)?.trim()
                  if (!name) return
                  renameSave(slot.id, name)
                  refresh()
                }}
              >
                Имя
              </button>
              <button
                title="Скачать файл сохранения"
                onClick={() => {
                  const file = exportSave(slot.id)
                  if (file) download(`${slot.name}.kharos.json`, JSON.stringify(file))
                  else setError('Мир этого слота ещё не сохранён')
                }}
              >
                Файл
              </button>
              {confirming === slot.id ? (
                <button
                  class="menu__danger"
                  onClick={() => {
                    deleteSave(slot.id)
                    setConfirming(null)
                    refresh()
                  }}
                >
                  Точно?
                </button>
              ) : (
                <button onClick={() => setConfirming(slot.id)}>Удалить</button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error && <p class="menu__error">{error}</p>}
      <div class="menu__inline">
        <button onClick={pick}>Загрузить файл</button>
      </div>
    </Window>
  )
}

function Network({ back, play }: { back(): void; play(launch: Launch): void }) {
  const [server, setServer] = useState(loadServer)
  const [recent, setRecent] = useState(recentServers)
  const join = (target: typeof server) => {
    try {
      localStorage.setItem(SERVER_KEY, JSON.stringify(target))
    } catch {
      // Адрес просто не запомнится.
    }
    play({ kind: 'server', ...target, name: cleanName(target.name) })
  }
  return (
    <Window title="Сетевая игра" back={back}>
      {recent.length > 0 && (
        <>
          <h3 class="menu__subtitle">Недавние серверы</h3>
          <ul class="menu__saves">
            {recent.map((item) => (
              <li key={item.url} class="menu__save">
                <div class="menu__save-info">
                  <strong>{item.url}</strong>
                  <small>
                    {date(item.played)}
                    {item.name && ` · ${item.name}`}
                  </small>
                </div>
                <span class="menu__inline">
                  <button class="menu__primary" onClick={() => join({ ...server, url: item.url, name: server.name || item.name })}>
                    Играть
                  </button>
                  <button
                    title="Убрать из списка"
                    onClick={() => {
                      forgetServer(item.url)
                      setRecent(recentServers())
                    }}
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <form
        class="menu__form"
        onSubmit={(event) => {
          event.preventDefault()
          join(server)
        }}
      >
        <label class="menu__field">
          <span>Ник</span>
          <input
            value={server.name}
            maxLength={NAME_LENGTH}
            placeholder="Как вас увидят другие"
            onInput={(event) => setServer({ ...server, name: event.currentTarget.value })}
          />
        </label>
        <label class="menu__field">
          <span>Адрес сервера</span>
          <input value={server.url} placeholder="ws://host:port" onInput={(event) => setServer({ ...server, url: event.currentTarget.value.trim() })} />
        </label>
        <label class="menu__field">
          <span>Задержка, мс</span>
          <input
            type="number"
            min={0}
            value={server.lag}
            title="Отладка: искусственная задержка в каждую сторону, чтобы почувствовать плохую сеть"
            onInput={(event) => setServer({ ...server, lag: Math.max(0, Number(event.currentTarget.value) || 0) })}
          />
        </label>
        <p class="menu__note">На сервере мир один на всех: его не начать заново и не сохранить у себя.</p>
        <span class="menu__inline">
          <button type="button" onClick={() => setServer({ ...server, url: localServerUrl() })}>
            Этот компьютер
          </button>
          <button type="submit" class="menu__primary" disabled={!/^wss?:\/\/./.test(server.url)}>
            Подключиться
          </button>
        </span>
      </form>
    </Window>
  )
}

interface SettingsProps {
  back(): void
  panel: boolean
  setPanel(panel: boolean): void
}

/** Настройки самого игрока. Всё, что относится к миру (погода, размер, зерно), задаётся при создании игры. */
function Settings({ back, panel, setPanel }: SettingsProps) {
  const [muted, setMuted] = useState(loadMuted)
  return (
    <Window title="Настройки" back={back}>
      <div class="menu__form">
        <h3 class="menu__group">Звук</h3>
        <label class="menu__check">
          <input
            type="checkbox"
            checked={!muted}
            onChange={(event) => {
              storeMuted(!event.currentTarget.checked)
              setMuted(!event.currentTarget.checked)
            }}
          />
          Звук в игре
        </label>
        <h3 class="menu__group">Отладка</h3>
        <label class="menu__check">
          <input type="checkbox" checked={panel} onChange={(event) => setPanel(event.currentTarget.checked)} />
          Панель генератора в игре
        </label>
      </div>
    </Window>
  )
}
