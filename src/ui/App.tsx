import { useEffect, useState } from 'preact/hooks'
import { loadSettings, saveSettings } from '../map/settings'
import { GameView } from './GameView'
import { launchFromAddress, recallLaunch, rememberLast, rememberLaunch, type Launch } from './launch'
import { Menu } from './Menu'
import { Showcase } from './Showcase'

/** Отладочная панель генератора: только по параметру ?panel в адресной строке, в настройках её нет. */
const loadPanel = () => new URLSearchParams(location.search).has('panel')

/**
 * Страница: главное меню над слайдами симуляции или сама игра. Игра, заданная адресной строкой (?server,
 * ?battle, ?sandbox), открывается сразу, минуя меню; после перезагрузки вкладка возвращается в свою игру.
 */
export function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [panel] = useState(loadPanel)
  const [launch, setLaunch] = useState<Launch | null>(() => launchFromAddress() ?? recallLaunch())

  useEffect(() => saveSettings(settings), [settings])
  // Перезагрузка страницы возвращает в ту же игру, а не в меню.
  useEffect(() => {
    rememberLaunch(launch)
    if (launch) rememberLast(launch)
  }, [launch])

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
      <Menu play={setLaunch} />
    </main>
  )
}
