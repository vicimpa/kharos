import { render } from 'preact'
import { App } from './ui/App'

const rootElement = document.querySelector<HTMLDivElement>('#root')

if (!rootElement) {
  throw new Error('Root element was not found')
}

render(<App />, rootElement)
