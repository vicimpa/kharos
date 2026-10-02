import { useState } from 'preact/hooks'
import { DEFAULT_SETTINGS, type BattleConfig, type MapSettings, type RenderConfig, type RulesConfig, type WeatherConfig, type WorldConfig } from '../map/settings'
import { PEAK_RADIUS_LIMIT, type GeneratorConfig } from '../map/terrain'
import { UNIT_NAMES } from './names'

interface Field<T> {
  key: keyof T
  label: string
  min: number
  max: number
  step: number
}

interface Group<T> {
  title: string
  fields: Field<T>[]
}

const biomeFields = (prefix: 'salt' | 'red' | 'marsh'): Field<GeneratorConfig>[] => [
  { key: `${prefix}SwampShift`, label: 'Больше болот', min: -0.2, max: 0.2, step: 0.005 },
  { key: `${prefix}RockShift`, label: 'Меньше скал', min: -0.2, max: 0.2, step: 0.005 },
  { key: `${prefix}PeakFactor`, label: 'Гор, раз', min: 0, max: 4, step: 0.1 },
]

const GENERATOR_GROUPS: Group<GeneratorConfig>[] = [
  {
    title: 'Зоны',
    fields: [
      { key: 'biomeScale', label: 'Размер биомов', min: 40, max: 600, step: 10 },
      { key: 'zoneScale', label: 'Размер зон', min: 16, max: 160, step: 1 },
      { key: 'zoneWarp', label: 'Изрезанность', min: 0, max: 80, step: 1 },
      { key: 'swampLevel', label: 'Уровень болот', min: 0, max: 1, step: 0.005 },
      { key: 'rockLevel', label: 'Уровень скал', min: 0, max: 1, step: 0.005 },
    ],
  },
  {
    title: 'Горы',
    fields: [
      { key: 'peakChance', label: 'Частота', min: 0, max: 1, step: 0.01 },
      { key: 'peakMinRadius', label: 'Мин. радиус', min: 0.5, max: PEAK_RADIUS_LIMIT, step: 0.05 },
      { key: 'peakMaxRadius', label: 'Макс. радиус', min: 0.5, max: PEAK_RADIUS_LIMIT, step: 0.05 },
      { key: 'doubleChance', label: 'Доля двойных', min: 0, max: 1, step: 0.01 },
      { key: 'tripleChance', label: 'Доля тройных', min: 0, max: 1, step: 0.01 },
    ],
  },
  { title: 'Биом: солончаки', fields: biomeFields('salt') },
  { title: 'Биом: красные пустоши', fields: biomeFields('red') },
  { title: 'Биом: топи', fields: biomeFields('marsh') },
]

const WORLD_GROUPS: Group<WorldConfig>[] = [
  {
    title: 'Мир',
    fields: [{ key: 'size', label: 'Сторона карты', min: 128, max: 4096, step: 64 }],
  },
]

const RENDER_GROUPS: Group<RenderConfig>[] = [
  {
    title: 'Барханы',
    fields: [
      { key: 'ergDunes', label: 'В эрге', min: 0, max: 1, step: 0.01 },
      { key: 'redDunes', label: 'В пустошах', min: 0, max: 1, step: 0.01 },
      { key: 'duneMargin', label: 'Отступ от зон', min: 0, max: 0.7, step: 0.01 },
    ],
  },
]

const WEATHER_GROUPS: Group<WeatherConfig>[] = [
  {
    title: 'Погода',
    fields: [
      { key: 'light', label: 'Освещение', min: 0, max: 1, step: 0.01 },
      { key: 'windX', label: 'Ветер, X', min: -8, max: 8, step: 0.1 },
      { key: 'windY', label: 'Ветер, Y', min: -8, max: 8, step: 0.1 },
      { key: 'precipitation', label: 'Осадки', min: 0, max: 1, step: 0.01 },
    ],
  },
]

/** Правила: действуют сразу, мир не начинается заново. */
const RULES_GROUPS: Group<RulesConfig>[] = [
  {
    title: 'Ремонт',
    fields: [
      { key: 'repairSpeed', label: 'Скорость, раз от стройки', min: 0.1, max: 10, step: 0.1 },
      { key: 'repairCost', label: 'Цена, доля от цены', min: 0, max: 2, step: 0.05 },
    ],
  },
]

const share = (key: 'infantry' | 'rocketeer' | 'buggy' | 'lancer' | 'tank' | 'tesla' | 'carrier' | 'drone' | 'gunship'): Field<BattleConfig> => ({
  key,
  label: UNIT_NAMES[key],
  min: 0,
  max: 3,
  step: 0.1,
})

/** Настройки случайного боя: действуют со следующего боя. */
const BATTLE_GROUPS: Group<BattleConfig>[] = [
  {
    title: 'Случайный бой',
    fields: [
      { key: 'budget', label: 'Цена армии', min: 500, max: 100000, step: 500 },
      { key: 'gap', label: 'Отступ сторон', min: 2, max: 30, step: 1 },
      { key: 'mirror', label: 'Одинаковые армии', min: 0, max: 1, step: 1 },
    ],
  },
  {
    title: 'Случайный бой: доля юнитов',
    fields: [share('infantry'), share('rocketeer'), share('buggy'), share('lancer'), share('tank'), share('tesla'), share('carrier'), share('drone'), share('gunship')],
  },
]

interface GroupsProps<T> {
  groups: Group<T>[]
  values: T
  onChange: (values: T) => void
}

function Groups<T extends object>({ groups, values, onChange }: GroupsProps<T>) {
  return groups.map((group) => (
    <fieldset key={group.title} class="panel__group">
      <legend>{group.title}</legend>
      {group.fields.map((field) => (
        <label key={String(field.key)} class="panel__row">
          <span>{field.label}</span>
          <input
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={values[field.key] as number}
            onInput={(event) => onChange({ ...values, [field.key]: Number(event.currentTarget.value) })}
          />
          <output>{values[field.key] as number}</output>
        </label>
      ))}
    </fieldset>
  ))
}

interface GeneratorPanelProps {
  settings: MapSettings
  onChange: (settings: MapSettings) => void
  /** Начать мир заново с теми же настройками. */
  onRestart: () => void
}

/** Отладочная панель: меняет параметры генератора и отрисовки, карта обновляется на лету. */
export function GeneratorPanel({ settings, onChange, onRestart }: GeneratorPanelProps) {
  const [open, setOpen] = useState(true)
  const setGenerator = (generator: GeneratorConfig) => onChange({ ...settings, generator })
  const setSeed = (seed: number) => setGenerator({ ...settings.generator, seed })

  if (!open) {
    return (
      <button class="panel panel--collapsed" onClick={() => setOpen(true)}>
        Генератор
      </button>
    )
  }

  return (
    <aside class="panel">
      <header class="panel__header">
        <strong>Генератор</strong>
        <button onClick={() => setOpen(false)}>Свернуть</button>
      </header>

      <label class="panel__row">
        <span>Сид</span>
        <input
          type="number"
          value={settings.generator.seed}
          onInput={(event) => setSeed(Math.trunc(Number(event.currentTarget.value)) || 0)}
        />
        <button onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}>Случайный</button>
      </label>

      <Groups groups={GENERATOR_GROUPS} values={settings.generator} onChange={setGenerator} />
      <Groups groups={WORLD_GROUPS} values={settings.world} onChange={(world) => onChange({ ...settings, world })} />
      <Groups groups={RENDER_GROUPS} values={settings.render} onChange={(render) => onChange({ ...settings, render })} />
      <Groups
        groups={WEATHER_GROUPS}
        values={settings.weather}
        onChange={(weather) => onChange({ ...settings, weather })}
      />

      <Groups groups={RULES_GROUPS} values={settings.rules} onChange={(rules) => onChange({ ...settings, rules })} />

      <Groups groups={BATTLE_GROUPS} values={settings.battle} onChange={(battle) => onChange({ ...settings, battle })} />

      <footer class="panel__footer">
        <button onClick={() => onChange(DEFAULT_SETTINGS)}>Сбросить</button>
        <button onClick={onRestart}>Новый мир</button>
        <button onClick={() => navigator.clipboard.writeText(JSON.stringify(settings, null, 2))}>
          Скопировать JSON
        </button>
      </footer>
    </aside>
  )
}
