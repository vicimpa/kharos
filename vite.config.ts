import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Относительные пути: клиент открывается и из корня домена, и из /kharos/ на GitHub Pages.
  base: './',
  plugins: [preact()],
})
