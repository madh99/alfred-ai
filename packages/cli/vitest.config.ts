import { defineConfig } from 'vitest/config';

// v1321 — wie packages/core (v1318): auf dem Entwicklungs-PC nahe am Commit-Limit starben die Worker
// („out of memory allocating heap arena map"). Prozesse statt Threads, höchstens vier parallel.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
