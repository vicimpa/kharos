import type { HudState } from '../game/hud'
import type { BuildingType, Command } from '../sim'
import { BUILDING_NAMES, UNIT_NAMES } from './names'

interface HudProps {
  state: HudState
  send: (command: Command) => void
  /** Начать выбор места под здание; null — отменить. */
  place: (building: BuildingType | null) => void
}

const percent = (value: number) => `${Math.round(value * 100)}%`

/** Интерфейс игрока: счёт и панель выбранного с приказами. Сам ничего не решает — только шлёт команды. */
export function Hud({ state, send, place }: HudProps) {
  const { units, building, site, construction, conversion, production } = state
  const selected = units.length > 0 || building !== null

  return (
    <>
      <div class="hud hud--credits" title="Кредиты">
        <span class="hud__coin" />
        {state.credits}
      </div>

      {selected && (
        <section class="hud hud--selection">
          <header class="hud__title">
            {building !== null
              ? `${site ? 'Стройка: ' : ''}${BUILDING_NAMES[building]}`
              : units.map(({ type, count }) => (count > 1 ? `${UNIT_NAMES[type]} ×${count}` : UNIT_NAMES[type])).join(', ')}
          </header>

          {site && (
            <>
              <div class="hud__progress">
                <span style={{ width: percent(site.progress) }} />
                <em>{site.started ? `Строится — ${percent(site.progress)}` : 'Ждёт строителя'}</em>
              </div>
              <button onClick={() => send({ type: 'cancelBuild', site: site.entity })}>Отменить стройку</button>
            </>
          )}

          {construction && (
            <>
              <div class="hud__row">
                {construction.options.map(({ building, cost, affordable }) => (
                  <button
                    key={building}
                    class={construction.placing === building ? 'is-active' : undefined}
                    disabled={!construction.available || !affordable}
                    title={
                      !construction.available ? 'Сначала разверни MCV в главное здание' : affordable ? undefined : 'Не хватает кредитов'
                    }
                    onClick={() => place(construction.placing === building ? null : building)}
                  >
                    {BUILDING_NAMES[building]} <small>{cost}</small>
                  </button>
                ))}
              </div>
              {construction.placing && <div class="hud__hint">Левая кнопка — заложить, правая или Esc — отмена</div>}
            </>
          )}

          {conversion &&
            (conversion.progress !== null ? (
              <div class="hud__progress">
                <span style={{ width: percent(conversion.progress) }} />
                <em>{conversion.kind === 'deploy' ? 'Разворачивается' : 'Сворачивается'}</em>
              </div>
            ) : (
              <button
                disabled={!conversion.possible}
                title={conversion.possible ? undefined : 'Нужна свободная скала 3×3 под машиной'}
                onClick={() => send(conversion.command)}
              >
                {conversion.kind === 'deploy' ? 'Развернуть' : 'Свернуть в MCV'}
              </button>
            ))}

          {production && (
            <>
              <div class="hud__row">
                {production.options.map(({ unit, cost, affordable }) => (
                  <button
                    key={unit}
                    disabled={!affordable || production.full}
                    title={production.full ? 'Очередь заполнена' : affordable ? undefined : 'Не хватает кредитов'}
                    onClick={() => send({ type: 'produce', producer: production.producer, unit })}
                  >
                    {UNIT_NAMES[unit]} <small>{cost}</small>
                  </button>
                ))}
              </div>
              {production.queue.length > 0 && (
                <>
                  <div class="hud__progress">
                    <span style={{ width: percent(production.progress) }} />
                    <em>{production.queue.map((unit) => UNIT_NAMES[unit]).join(' → ')}</em>
                  </div>
                  <button onClick={() => send({ type: 'cancelProduction', producer: production.producer })}>
                    Отменить последний
                  </button>
                </>
              )}
            </>
          )}
        </section>
      )}
    </>
  )
}
