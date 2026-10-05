import { render } from 'preact'
import { App } from './ui/App'
import { installSkin } from './ui/skin'

const rootElement = document.querySelector<HTMLDivElement>('#root')

if (!rootElement) {
  throw new Error('Root element was not found')
}

installSkin()
render(<App />, rootElement)
