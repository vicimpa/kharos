import type { Audio } from '../audio/audio'
import type { SoundName } from '../audio/synth'
import type { Entity } from '../ecs'
import { Unit, type Command, type Sim } from '../sim'

/** Громкость звуков интерфейса: тише боя, но слышна поверх него. */
const VOLUME = 0.35
const HOVER_VOLUME = 0.12
/** Чаще этого, в секундах, выделение не звучит: протянутая рамка меняет его каждый кадр. */
const SELECT_GAP = 0.12

/** Какие приказы как звучат; остальные команды — молча: их и так сопровождает щелчок кнопки. */
const ORDER_SOUNDS: Partial<Record<Command['type'], SoundName>> = {
  move: 'order',
  patrol: 'order',
  route: 'order',
  serve: 'order',
  pickup: 'order',
  harvest: 'order',
  haul: 'order',
  assist: 'order',
  attack: 'attackOrder',
  rally: 'place',
  build: 'place',
  pave: 'place',
  unpave: 'place',
}

/**
 * Звуки интерфейса: щелчок по кнопке, касание кнопки при наведении, вход в раздел, отказ у недоступной кнопки,
 * подтверждение приказов и выделение юнитов и зданий. Кнопки слушаются одним обработчиком на документе — компонентам
 * не нужно о них знать; приказы — обёрткой отправки команд игрока; выделение — сверкой раз в кадр.
 */
export function createInterfaceSounds(sim: Sim, audio: Audio) {
  const play = (name: SoundName, volume = VOLUME) => audio.play(name, volume, 0)

  const button = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLButtonElement>('.hud button, .game button') : null)
  const down = (event: PointerEvent) => {
    const pressed = button(event.target)
    if (!pressed) return
    if (pressed.disabled) play('deny')
    else play(pressed.classList.contains('bar__cell--group') ? 'open' : 'click')
  }
  let hovered: Element | null = null
  const over = (event: PointerEvent) => {
    // Касание — у любой кнопки интерфейса, как в меню: у сетки команд, верхней полосы, ленты уведомлений.
    const cell = button(event.target)
    if (cell === hovered) return
    hovered = cell
    if (cell && !cell.disabled) play('hover', HOVER_VOLUME)
  }
  document.addEventListener('pointerdown', down, true)
  document.addEventListener('pointerover', over)

  // Приказ звучит, когда уходит хосту: так одинаково для мыши, горячих клавиш и мини-карты.
  const send = sim.send.bind(sim)
  sim.send = (player, command) => {
    const sound = ORDER_SOUNDS[command.type]
    if (sound) play(sound)
    return send(player, command)
  }

  let selected = ''
  let clock = 0
  let selectedAt = -Infinity
  return {
    /** Раз в кадр: выделение сменилось и в нём что-то есть — щелчок, у юнитов один, у здания другой. Снятое молчит. */
    update(seconds: number, selection: ReadonlySet<Entity>) {
      clock += seconds
      const key = [...selection].join(',')
      if (key === selected) return
      selected = key
      if (!selection.size || clock - selectedAt < SELECT_GAP) return
      selectedAt = clock
      play([...selection].some((entity) => sim.world.has(entity, Unit)) ? 'select' : 'selectBuilding')
    },
    destroy() {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerover', over)
      sim.send = send
    },
  }
}
