import { PEAK_RADIUS_LIMIT, type GeneratorConfig } from '../map/terrain'

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

export const GENERATOR_GROUPS: Group<GeneratorConfig>[] = [
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

interface GroupsProps<T> {
  groups: Group<T>[]
  values: T
  onChange: (values: T) => void
}

/** Ползунки по группам: каждый меняет одно числовое поле values. */
export function Groups<T extends object>({ groups, values, onChange }: GroupsProps<T>) {
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
