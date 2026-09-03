import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Emulator integration tests perform real network calls (Auth Emulator
    // sign-in, Functions Emulator callable invocation) — default timeouts
    // are too tight for a cold emulator start.
    testTimeout: 20000,
    hookTimeout: 20000,
    // SEC-006 Stage 2: test/emulator now has more than one file exercising
    // the SAME shared global document (system/maintenance) against the
    // SAME real Firestore Emulator backend. Vitest's default file
    // parallelism runs test files concurrently in separate workers, which
    // for ordinary unit tests is safe (no shared external state) but is
    // NOT safe here: one file's in-flight writes to a global doc can land
    // while another file's test is mid-assertion against that same doc,
    // producing cross-file flakes unrelated to either file's own logic
    // (observed: createCompany.test.ts's maintenance-mode race test and
    // inviteMember.test.ts's own maintenance-mode test intermittently
    // interfered with each other before this was set). Emulator
    // integration tests are comparatively few and run fine sequentially.
    // test:unit shares this config too, so it also becomes sequential — a
    // negligible cost for its ~180 pure-in-process tests, which have no
    // shared external state to race on anyway.
    fileParallelism: false,
  },
})
