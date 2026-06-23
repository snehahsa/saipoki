import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  build: {
    outDir: '../static/game',
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      name: 'TelegramGame',
      formats: ['iife'],
      fileName: () => 'game.js',
    },
    rollupOptions: {
      output: {
        extend: true,
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: [
      { find: '@/utils/pixi/PlayApp', replacement: path.resolve(__dirname, 'src/PlayApp.ts') },
      { find: '@/utils/pixi/flows', replacement: path.resolve(__dirname, 'src/flows.ts') },
      { find: '@/utils/pixi/Player/Player', replacement: path.resolve(__dirname, 'src/Player.ts') },
      { find: '@/utils/backend/server', replacement: path.resolve(__dirname, 'src/server.ts') },
      { find: '@/utils/signal', replacement: path.resolve(__dirname, 'src/signal.ts') },
      { find: '@', replacement: path.resolve(__dirname, '../gather-clone/frontend') },
      { find: 'pixi.js', replacement: path.resolve(__dirname, 'node_modules/pixi.js') },
      { find: 'gsap', replacement: path.resolve(__dirname, 'node_modules/gsap') },
      { find: 'socket.io-client', replacement: path.resolve(__dirname, 'node_modules/socket.io-client') },
    ],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
