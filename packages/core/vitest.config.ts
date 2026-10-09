import { defineConfig } from 'vitest/config';

// v1318 — Realfall 08./09.10.: ohne Konfiguration startet vitest je CPU einen Worker (32 auf dem Entwicklungs-PC),
// jeder lädt den Kern komplett; die Suite starb viermal mit „VirtualAlloc failed", „Zone Allocation failed" oder
// „Channel closed" (ein Worker tot), obwohl 68 GB frei waren. Prozesse statt Threads, höchstens sechs parallel.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { maxForks: 6, minForks: 1 } },
  },
});
