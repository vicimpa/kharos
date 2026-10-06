import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { loadMuted, storeMuted } from '../audio/audio'
import { createSlot, deleteSave, exportSave, importSave, listSaves, renameSave, type SaveSlot } from '../game/storage'
import { DEFAULT_SETTINGS, type MapSettings } from '../map/settings'
import { localServerUrl, type Launch } from './launch'

/** Симуляция идёт 20 тиков в секунду. */
const TICKS_PER_SECOND = 20
/** Какой стороны бывает карта новой игры, в тайлах. */
const MAP_SIZES = [512, 1024, 2048]
const SERVER_KEY = 'kharos.server'

type Screen = 'main' | 'new' | 'saves' | 'network' | 'settings'

interface MenuProps {
  settings: MapSettings
  setSettings(settings: MapSettings): void
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
    const saved = JSON.parse(localStorage.getItem(SERVER_KEY) ?? 'null') as { url?: unknown; lag?: unknown } | null
    return { url: typeof saved?.url === 'string' ? saved.url : localServerUrl(), lag: typeof saved?.lag === 'number' ? saved.lag : 0 }
  } catch {
    return { url: localServerUrl(), lag: 0 }
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
 * к серверу, сыграть показательный бой или тестовую карту, настроить игру.
 */
export function Menu({ settings, setSettings, panel, setPanel, play }: MenuProps) {
  const [screen, setScreen] = useState<Screen>('main')
  const [saves, setSaves] = useState(listSaves)
  const refresh = () => setSaves(listSaves())
  const home = () => setScreen('main')
  const last = saves[0]

  return (
    <div class="menu">
      <h1 class="menu__logo">KHAROS</h1>
      {screen === 'main' && (
        <Window title="Главное меню">
          <nav class="menu__list">
            <button disabled={!last} title={last ? `${last.name} — ${playtime(last.tick)}` : undefined} onClick={() => last && play({ kind: 'save', slot: last })}>
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
            <button onClick={() => play({ kind: 'battle' })}>Случайный бой</button>
            <button onClick={() => play({ kind: 'sandbox' })}>Тестовая карта</button>
            <button onClick={() => setScreen('settings')}>Настройки</button>
          </nav>
        </Window>
      )}
      {screen === 'new' && <NewGame back={home} play={play} count={saves.length} />}
      {screen === 'saves' && <Saves back={home} saves={saves} refresh={refresh} play={play} />}
      {screen === 'network' && <Network back={home} play={play} />}
      {screen === 'settings' && <Settings back={home} settings={settings} setSettings={setSettings} panel={panel} setPanel={setPanel} />}
    </div>
  )
}

function NewGame({ back, play, count }: { back(): void; play(launch: Launch): void; count: number }) {
  const [name, setName] = useState(`Игра ${count + 1}`)
  const [seed, setSeed] = useState(randomSeed)
  const [size, setSize] = useState(DEFAULT_SETTINGS.world.size)
  return (
    <Window title="Новая игра" back={back}>
      <form
        class="menu__form"
        onSubmit={(event) => {
          event.preventDefault()
          play({ kind: 'save', slot: createSlot(name.trim() || `Игра ${count + 1}`, size, seed) })
        }}
      >
        <label class="menu__field">
          <span>Название</span>
          <input value={name} maxLength={40} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label class="menu__field">
          <span>Зерно карты</span>
          <span class="menu__inline">
            <input type="number" value={seed} onInput={(event) => setSeed(Math.floor(Number(event.currentTarget.value)) || 0)} />
            <button type="button" title="Другая случайная местность" onClick={() => setSeed(randomSeed())}>
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
        <button type="submit" class="menu__primary">
          Начать
        </button>
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
  return (
    <Window title="Сетевая игра" back={back}>
      <form
        class="menu__form"
        onSubmit={(event) => {
          event.preventDefault()
          try {
            localStorage.setItem(SERVER_KEY, JSON.stringify(server))
          } catch {
            // Адрес просто не запомнится.
          }
          play({ kind: 'server', ...server })
        }}
      >
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
  settings: MapSettings
  setSettings(settings: MapSettings): void
  panel: boolean
  setPanel(panel: boolean): void
}

function Settings({ back, settings, setSettings, panel, setPanel }: SettingsProps) {
  const [muted, setMuted] = useState(loadMuted)
  const { weather, rules } = settings
  const base = DEFAULT_SETTINGS.rules
  const slider = (label: string, value: number, min: number, max: number, step: number, change: (value: number) => void, tip?: string) => (
    <label class="menu__field menu__field--slider" title={tip}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(event) => change(Number(event.currentTarget.value))} />
      <output>{Number(value.toFixed(2))}</output>
    </label>
  )
  return (
    <Window title="Настройки" back={back} wide>
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
        <h3 class="menu__group">Погода</h3>
        {slider('Освещение', weather.light, 0, 1, 0.05, (light) => setSettings({ ...settings, weather: { ...weather, light } }), '0 — ночь, 1 — полдень')}
        {slider('Осадки', weather.precipitation, 0, 1, 0.05, (precipitation) => setSettings({ ...settings, weather: { ...weather, precipitation } }), '0 — ясно, 1 — буря')}
        <h3 class="menu__group">Правила локальной игры</h3>
        {slider('Скорость ремонта', rules.repairSpeed, 0, base.repairSpeed * 3, base.repairSpeed / 10, (repairSpeed) => setSettings({ ...settings, rules: { ...rules, repairSpeed } }))}
        {slider('Цена ремонта', rules.repairCost, 0, base.repairCost * 3, base.repairCost / 10, (repairCost) => setSettings({ ...settings, rules: { ...rules, repairCost } }))}
        {slider('Пауза перед ремонтом', rules.repairPause, 0, base.repairPause * 3, base.repairPause / 10, (repairPause) => setSettings({ ...settings, rules: { ...rules, repairPause } }), 'Сколько секунд здание не чинится после попадания')}
        <h3 class="menu__group">Отладка</h3>
        <label class="menu__check">
          <input type="checkbox" checked={panel} onChange={(event) => setPanel(event.currentTarget.checked)} />
          Панель генератора в игре
        </label>
        <span class="menu__inline">
          <button
            onClick={() => setSettings({ ...settings, weather: DEFAULT_SETTINGS.weather, rules: DEFAULT_SETTINGS.rules })}
          >
            Сбросить
          </button>
        </span>
      </div>
    </Window>
  )
}
