import type { HudState } from '../game/hud'
import { useEffect, useRef, useState } from 'preact/hooks'
import { REWARDS, type BuildingType, type Command, type Reward } from '../sim'
import { BUILDING_NAMES, REWARD_NAMES, UNIT_NAMES } from './names'

interface HudProps {
  state: HudState
  send: (command: Command) => void
  /** Начать выбор места под здание; null — отменить. */
  place: (building: BuildingType | null) => void
}

const percent = (value: number) => `${Math.round(value * 100)}%`

/** Сколько секунд сообщение о награде висит на экране. */
const TOAST_SECONDS = 5

/** Награды, полученные только что: каждая показывается TOAST_SECONDS. Те, что были до открытия страницы, не показываются. */
function useNewRewards(rewards: string[]) {
  const seen = useRef(rewards.length)
  const [fresh, setFresh] = useState<string[]>([])
  useEffect(() => {
    const added = rewards.slice(seen.current)
    // Список стал короче — мир начался заново: считаем с нуля.
    seen.current = rewards.length
    if (!added.length) return
    setFresh((list) => [...list, ...added])
    // Таймер не отменяется при следующей награде: иначе прежнее сообщение осталось бы висеть.
    setTimeout(() => setFresh((list) => list.filter((key) => !added.includes(key))), TOAST_SECONDS * 1000)
  }, [rewards.length])
  return fresh
}

/** Интерфейс игрока: счёт и панель выбранного с приказами. Сам ничего не решает — только шлёт команды. */
export function Hud({ state, send, place }: HudProps) {
  const { units, building, ore, site, demolish, construction, conversion, production } = state
  const selected = units.length > 0 || building !== null
  const fresh = useNewRewards(state.rewards)

  return (
    <>
      <div class="hud hud--credits" title="Кредиты">
        <span class="hud__coin" />
        {state.credits}
        {state.income > 0 && <small>+{state.income}/с</small>}
      </div>

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

      {selected && (
        <section class="hud hud--selection">
          <header class="hud__title">
            {building !== null
              ? `${site ? (site.demolish ? 'Разбор: ' : 'Стройка: ') : ''}${BUILDING_NAMES[building]}`
              : units.map(({ type, count }) => (count > 1 ? `${UNIT_NAMES[type]} ×${count}` : UNIT_NAMES[type])).join(', ')}
          </header>

          {state.power && (
            <div class={state.power.demand > state.power.produced ? 'hud__hint hud__power is-short' : 'hud__hint hud__power'}>
              ⚡ Энергия зоны: потребляется {state.power.demand} из {state.power.produced}
              {state.power.demand > state.power.produced && ' — перегруз, станции разрушаются'}
            </div>
          )}
          {state.starved && <div class="hud__hint hud__power is-short">⚡ Не хватает энергии: здание работает медленнее</div>}
          {state.health !== null && <div class="hud__hint">Прочность: {percent(state.health)}</div>}

          {ore !== null && <div class="hud__hint">{ore > 0 ? `Руды в месторождении: ${ore}` : 'Месторождение выработано'}</div>}

          {site && (
            <>
              <div class="hud__progress">
                <span style={{ width: percent(site.progress) }} />
                <em>
                  {site.demolish
                    ? site.progress < 1
                      ? `Разбирается — осталось ${percent(site.progress)}`
                      : 'Ждёт строителя: выбери его и щёлкни по зданию правой кнопкой'
                    : site.started
                      ? `Строится — ${percent(site.progress)}`
                      : site.blocked
                        ? 'Место занято юнитами'
                        : 'Ждёт строителя'}
                </em>
              </div>
              <button onClick={() => send({ type: 'cancelBuild', site: site.entity })}>
                {site.demolish ? 'Отменить разбор' : 'Отменить стройку'}
              </button>
            </>
          )}

          {demolish && (
            <button
              title="Здание разберут строители; когда закончат, вернётся половина цены"
              onClick={() => send({ type: 'demolish', building: demolish.building, builders: [] })}
            >
              Разобрать <small>+{demolish.refund}</small>
            </button>
          )}

          {construction && (
            <>
              <div class="hud__list">
                {construction.options.map(({ building, cost, affordable, power }) => (
                  <button
                    key={building}
                    class={construction.placing === building ? 'is-active' : undefined}
                    disabled={!construction.available || !affordable}
                    title={
                      !construction.available
                        ? 'Сначала разверни MCV в главное здание'
                        : affordable
                          ? undefined
                          : 'Не хватает кредитов'
                    }
                    onClick={() => place(construction.placing === building ? null : building)}
                  >
                    <span>{BUILDING_NAMES[building]}</span>
                    {power !== 0 && <small class="hud__power">⚡{power > 0 ? `+${power}` : power}</small>}
                    <small class="hud__cost">{cost}</small>
                  </button>
                ))}
              </div>
              {construction.placing && <div class="hud__hint">Левая кнопка — заложить, правая или Esc — отмена</div>}
            </>
          )}

          {conversion &&
            (conversion.progress !== null ? (
              <>
                <div class="hud__progress">
                  <span style={{ width: percent(conversion.progress) }} />
                  <em>
                    {conversion.blocked
                      ? 'Место занято юнитами'
                      : conversion.kind === 'deploy'
                        ? 'Разворачивается'
                        : 'Сворачивается'}
                  </em>
                </div>
                {conversion.cancel && <button onClick={() => send(conversion.cancel!)}>Отменить</button>}
              </>
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
