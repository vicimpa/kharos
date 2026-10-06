import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // На GitHub Pages клиент живёт не в корне домена, а в /<репозиторий>/.
  base: process.env.BASE ?? '/',
  plugins: [preact()],
})
