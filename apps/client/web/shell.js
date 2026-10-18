// Браузерная оболочка клиента (src/web.rs): события страницы — в ввод игры, сохранения и настройки — в IndexedDB.
// Подключается к выходу Emscripten через --pre-js и живёт в одной области с его рантаймом (FS, IDBFS).

Module.preRun = Module.preRun || []
Module.postRun = Module.postRun || []

// Папка настроек и сохранений (~/.config/kharos, saves.rs) — в IndexedDB: переживает перезагрузку страницы.
const CONFIG = '/home/web_user/.config'

Module.preRun.push(() => {
  FS.mkdirTree(CONFIG)
  FS.mount(IDBFS, { autoPersist: true }, CONFIG)
  addRunDependency('kharos-config')
  FS.syncfs(true, (error) => {
    if (error) console.warn('сохранения:', error)
    removeRunDependency('kharos-config')
  })
})

// Имя клавиши — как у нативной оболочки (shell.rs, key_name): буквы и цифры по месту на клавиатуре, остальное — по смыслу.
const NAMED = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Space: 'space', Escape: 'escape',
  Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end',
  ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt',
  MetaLeft: 'meta', MetaRight: 'meta', Minus: '-', Equal: '=',
}

function keyName(event) {
  const code = event.code || ''
  if (code.startsWith('Key')) return code.slice(3).toLowerCase()
  if (code.startsWith('Digit')) return code.slice(5)
  if (NAMED[code]) return NAMED[code]
  if (/^F\d+$/.test(code)) return code.toLowerCase()
  return event.key && event.key.length ? event.key.toLowerCase() : null
}

Module.postRun.push(() => {
  const canvas = document.getElementById('canvas')
  const call = (name, types, args) => Module.ccall(name, null, types, args)
  const point = (event) => {
    const rect = canvas.getBoundingClientRect()
    call('kharos_pointer', ['number', 'number', 'number'], [event.clientX - rect.left, event.clientY - rect.top, event.pointerType === 'touch' ? 1 : 0])
  }
  // Кнопки указателя: левая, правая, средняя — как BUTTONS в input.rs.
  const BUTTON = { 0: 0, 2: 1, 1: 2 }
  canvas.addEventListener('pointermove', point)
  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus()
    canvas.setPointerCapture(event.pointerId)
    point(event)
    if (event.button in BUTTON) call('kharos_button', ['number', 'number'], [BUTTON[event.button], 1])
    event.preventDefault()
  })
  canvas.addEventListener('pointerup', (event) => {
    point(event)
    if (event.button in BUTTON) call('kharos_button', ['number', 'number'], [BUTTON[event.button], 0])
  })
  canvas.addEventListener('pointercancel', () => call('kharos_button', ['number', 'number'], [0, 0]))
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch') call('kharos_leave', [], [])
  })
  // Колесо — в строках, вверх больше нуля; щелчок колеса в Chrome — 40 пикселей, как у нативной оболочки.
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault()
    const lines = event.deltaMode === 1 ? -event.deltaY : event.deltaMode === 2 ? -event.deltaY * 20 : -event.deltaY / 40
    call('kharos_wheel', ['number'], [lines])
  }, { passive: false })
  canvas.addEventListener('contextmenu', (event) => event.preventDefault())
  const key = (event, down) => {
    const name = keyName(event)
    if (name) call('kharos_key', ['string', 'number', 'number'], [name, down ? 1 : 0, event.repeat ? 1 : 0])
    if (down && event.key && event.key.length === 1 && !event.ctrlKey && !event.metaKey) call('kharos_text', ['string'], [event.key])
    // Странице клавиши игры не нужны (прокрутка пробелом и стрелками, Tab), а сочетания браузера — свои.
    if (!event.ctrlKey && !event.metaKey) event.preventDefault()
  }
  canvas.addEventListener('keydown', (event) => key(event, true))
  canvas.addEventListener('keyup', (event) => key(event, false))
  window.addEventListener('focus', () => call('kharos_focus', ['number'], [1]))
  window.addEventListener('blur', () => call('kharos_focus', ['number'], [0]))
  // Уходят со страницы — партия слота записывается.
  window.addEventListener('pagehide', () => call('kharos_save', [], []))
  canvas.focus()
})
