import type { Audio } from '../audio/audio'
import type { SoundName } from '../audio/synth'
import type { Command, Sim } from '../sim'

/** Громкость звуков интерфейса: тише боя, но слышна поверх него. */
const VOLUME = 0.35
const HOVER_VOLUME = 0.12
/** Какие приказы как звучат; остальные команды — молча: их и так сопровождает щелчок кнопки. */
const ORDER_SOUNDS: Partial<Record<Command['type'], SoundName>> = {
  move: 'order',
  patrol: 'order',
  route: 'order',
  harvest: 'order',
  haul: 'order',
  assist: 'order',
  attack: 'attackOrder',
  build: 'place',
  pave: 'place',
  unpave: 'place',
}

/**
 * Звуки интерфейса: щелчок по кнопке, касание ячейки сетки при наведении, вход в раздел, отказ у недоступной кнопки
 * и подтверждение приказов. Кнопки слушаются одним обработчиком на документе — компонентам не нужно о них знать;
 * приказы — обёрткой отправки команд игрока. Возвращает функцию, которая всё снимает.
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
    const cell = event.target instanceof Element ? event.target.closest('.bar__cell:not(.bar__cell--empty)') : null
    if (cell === hovered) return
    hovered = cell
    if (cell) play('hover', HOVER_VOLUME)
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

  return () => {
    document.removeEventListener('pointerdown', down, true)
    document.removeEventListener('pointerover', over)
    sim.send = send
  }
}
