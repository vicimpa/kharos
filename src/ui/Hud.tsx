import type { HudState, Stack } from '../game/hud'
import { cssColor } from '../game/resourceColors'
import { useEffect, useRef, useState } from 'preact/hooks'
import { REWARDS, type BuildingType, type Command, type Resource, type Reward } from '../sim'
import { BUILDING_NAMES, RESOURCE_NAMES, REWARD_NAMES, UNIT_NAMES } from './names'

interface HudProps {
  state: HudState
  send: (command: Command) => void
  /** Начать выбор места под здание; null — отменить. */
  place: (building: BuildingType | null) => void
}

const percent = (value: number) => `${Math.round(value * 100)}%`

/** Значок ресурса цвета ресурса и количество; название — во всплывающей подсказке. */
function Res({ resource, amount, of }: { resource: Resource; amount?: number; of?: number }) {
  return (
    <span class="hud__res" title={RESOURCE_NAMES[resource]}>
      <i style={{ background: cssColor(resource) }} />
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
  const { units, building, deposit, site, demolish, construction, conversion, production } = state
  const selected = units.length > 0 || building !== null
  const fresh = useNewRewards(state.rewards)

  return (
    <>
      <div class="hud hud--credits" title="Кредиты">
        <span class="hud__coin" />
        {state.credits}
        {state.income > 0 && <small>+{state.income}/с</small>}
        {state.stock && (
          <span class="hud__stock" title={`Запас в хранилищах; всего помещается ${state.stock.capacity}`}>
            <Stacks items={state.stock.items} />
            {state.stock.items.length === 0 && <span class="hud__res">хранилища пусты</span>}
          </span>
        )}
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
          {state.starved && <div class="hud__hint hud__power is-short">⚡ Не хватает энергии: здание работает медленнее или стоит</div>}
          {state.health !== null && (
            <div class="hud__hint">Прочность: {percent(state.health)}. Починка стоит {state.repair}: выбери строителей и щёлкни по зданию правой кнопкой</div>
          )}

          {state.army && state.army.health < 1 && <div class="hud__hint">Прочность: {percent(state.army.health)}. Технику чинят строители, пехота поправляется сама</div>}
          {state.army && state.army.armed > 0 && (
            <div class="hud__hint">Сами стреляют по врагам в пределах выстрела. Правый щелчок по врагу — атаковать</div>
          )}

          {state.stored && (
            <div class="hud__hint">
              {state.stored.store ? 'Хранилище' : 'Склад'}: <Stacks items={state.stored.items} />
              {state.stored.items.length === 0 && 'пусто'} — вмещает {state.stored.capacity}
            </div>
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
              {state.cargo.bound > 0
                ? 'Возит из шахты в хранилища'
                : state.cargo.busy > 0
                  ? 'Везёт по заявке зоны'
                  : 'Свободен: сам берёт заявки зон. Правый щелчок по шахте — возить только из неё'}
            </div>
          )}
          {state.trade &&
            (state.trade.order ? (
              <>
                <div class="hud__progress">
                  <span
                    style={{ width: percent(state.trade.order.flight ?? state.trade.order.delivered / state.trade.order.wanted) }}
                  />
                  <em>
                    {state.trade.order.flight !== null
                      ? `Корабль в пути: ${RESOURCE_NAMES[state.trade.order.resource].toLowerCase()} ×${state.trade.order.wanted} за ${state.trade.order.wanted * state.trade.order.price}`
                      : `Грузовики везут ${RESOURCE_NAMES[state.trade.order.resource].toLowerCase()}: ${state.trade.order.delivered} из ${state.trade.order.wanted}`}
                  </em>
                </div>
                {state.trade.order.flight === null && (
                  <>
                    <div class="hud__hint">Товар возят свободные грузовики — не привязанные к шахте</div>
                    <button onClick={() => send({ type: 'closeSale', port: state.trade!.port })}>
                      {state.trade.order.delivered > 0 ? 'Отправить, что привезли' : 'Снять заявку'}
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <div class="hud__hint">Продажа из хранилищ зоны, цена за единицу:</div>
                {state.trade.offers.map(({ resource, available, price }) => (
                  <div key={resource} class="hud__row">
                    <Res resource={resource} amount={available} />
                    <small>
                      {RESOURCE_NAMES[resource]}, по {price}
                    </small>
                    {[50, available]
                      .filter((amount, i, all) => amount > 0 && amount <= available && all.indexOf(amount) === i)
                      .map((amount) => (
                        <button key={amount} onClick={() => send({ type: 'sell', port: state.trade!.port, resource, amount })}>
                          {amount === available ? 'Всё' : amount} <small>+{amount * price}</small>
                        </button>
                      ))}
                  </div>
                ))}
                {state.trade.offers.length === 0 && <button disabled>Продавать нечего</button>}
              </>
            ))}

          {deposit && (
            <div class="hud__hint">
              <Res resource={deposit.kind} /> {RESOURCE_NAMES[deposit.kind]}: {deposit.left > 0 ? `осталось ${deposit.left}` : 'месторождение выработано'}
            </div>
          )}

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
                {construction.options.map(({ building, cost, affordable, power, materials }) => (
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
                    {materials.length > 0 && <small><Stacks items={materials} /></small>}
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
              <div class="hud__list">
                {production.options.map(({ unit, cost, affordable, materials }) => (
                  <button
                    key={unit}
                    disabled={!affordable || production.full}
                    title={production.full ? 'Очередь заполнена' : affordable ? undefined : 'Не хватает кредитов'}
                    onClick={() => send({ type: 'produce', producer: production.producer, unit })}
                  >
                    <span>{UNIT_NAMES[unit]}</span>
                    {materials.length > 0 && <small><Stacks items={materials} /></small>}
                    <small class="hud__cost">{cost}</small>
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
