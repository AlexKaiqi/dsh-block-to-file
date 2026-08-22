import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Durability tests drive real Git repositories and run in parallel with
    // the other files; 5s (vitest default) is too tight under load.
    testTimeout: 10_000,
  },
})
