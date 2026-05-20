import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Tests live next to source files (foo.test.ts beside foo.ts) and we
        // also accept a top-level tests/ folder if it shows up later.
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        environment: 'node',
        // crypto.ts uses globalThis.crypto.subtle (Web Crypto), which is
        // available on Node 18.17+. No special setup needed.
        globals: false,
        // Each test file gets a fresh isolated module graph so module-level
        // state in src/crypto.ts (cachedKeyPair etc.) doesn't leak across
        // test files.
        isolate: true,
    },
});
