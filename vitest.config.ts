import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      'momai:sdk': resolve(__dirname, 'src/sdk-test.ts')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [['src/*.test.tsx', 'jsdom']],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
