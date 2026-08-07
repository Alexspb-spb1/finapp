import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Emulator integration tests perform real network calls (Auth Emulator
    // sign-in, Functions Emulator callable invocation) — default timeouts
    // are too tight for a cold emulator start.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
