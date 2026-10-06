import { useEffect, useState } from 'preact/hooks'
import { loadSettings, saveSettings } from '../map/settings'
import { GameView } from './GameView'
import { launchFromAddress, recallLaunch, rememberLast, rememberLaunch, type Launch } from './launch'
import { Menu } from './Menu'
import { Showcase } from './Showcase'

const PANEL_KEY = 'kharos.panel'

/** Отладочная панель генератора: включается в настройках или параметром ?panel в адресной строке. */
function loadPanel() {
  if (new URLSearchParams(location.search).has('panel')) return true
  try {
    return localStorage.getItem(PANEL_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Страница: главное меню над слайдами симуляции или сама игра. Игра, заданная адресной строкой (?server,
 * ?battle, ?sandbox), открывается сразу, минуя меню; после перезагрузки вкладка возвращается в свою игру.
 */
export function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [panel, setPanel] = useState(loadPanel)
  const [launch, setLaunch] = useState<Launch | null>(() => launchFromAddress() ?? recallLaunch())

  useEffect(() => saveSettings(settings), [settings])
  // Перезагрузка страницы возвращает в ту же игру, а не в меню.
  useEffect(() => {
    rememberLaunch(launch)
    if (launch) rememberLast(launch)
  }, [launch])
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, panel ? '1' : '0')
    } catch {
      // Выбор просто не запомнится.
    }
  }, [panel])

  if (launch) {
    return (
      <GameView
        launch={launch}
        settings={settings}
        setSettings={setSettings}
        panel={panel}
        exit={() => {
          // Из игры, открытой адресной строкой, меню возвращает без параметров: иначе перезагрузка снова откроет её.
          if (location.search) history.replaceState(null, '', location.pathname)
          setLaunch(null)
        }}
      />
    )
  }
  return (
    <main class="game">
      <Showcase settings={settings} />
      <Menu panel={panel} setPanel={setPanel} play={setLaunch} />
    </main>
  )
}
