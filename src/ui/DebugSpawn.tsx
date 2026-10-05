import { useState } from 'preact/hooks'
import type { Spawn } from '../game/scene'
import { buildingPortrait, unitPortrait } from '../game/portraits'
import { BUILDING_TYPES, UNIT_TYPES } from '../sim'
import { BUILDING_NAMES, UNIT_NAMES } from './names'

const TABS = [
  { kind: 'building', label: 'Здания' },
  { kind: 'unit', label: 'Свои' },
  { kind: 'enemy', label: 'Враги' },
] as const

/**
 * Отладочный спавн с выбором: вкладки зданий, своих юнитов и юнитов учебного противника. Выбранное ставится
 * щелчком левой кнопки по карте, сколько угодно раз; правая кнопка или Esc — отмена. Здания ставятся готовыми и бесплатно.
 */
export function DebugSpawn({ spawning, spawn }: { spawning: Spawn | null; spawn: (spawn: Spawn | null) => void }) {
  const [kind, setKind] = useState<Spawn['kind']>(spawning?.kind ?? 'unit')
  const types = kind === 'building' ? BUILDING_TYPES : UNIT_TYPES
  return (
    <section class="hud debug">
      <div class="debug__tabs">
        {TABS.map((tab) => (
          <button key={tab.kind} class={tab.kind === kind ? 'is-active' : undefined} onClick={() => setKind(tab.kind)}>
            {tab.label}
          </button>
        ))}
      </div>
      <div class="debug__list">
        {types.map((type) => {
          const active = spawning?.kind === kind && spawning.type === type
          const name = kind === 'building' ? BUILDING_NAMES[type as keyof typeof BUILDING_NAMES] : UNIT_NAMES[type as keyof typeof UNIT_NAMES]
          return (
            <button
              key={type}
              class={active ? 'is-active' : undefined}
              data-tip={name}
              onClick={() => spawn(active ? null : ({ kind, type } as Spawn))}
            >
              <img src={kind === 'building' ? buildingPortrait(type as never) : unitPortrait(type as never, kind === 'enemy' ? 'foe' : 'own')} alt="" />
              <span>{name}</span>
            </button>
          )
        })}
      </div>
      <div class="hud__hint">
        {spawning ? 'Левая кнопка по карте — поставить, правая или Esc — хватит' : 'Выбери, что ставить'}
      </div>
    </section>
  )
}
