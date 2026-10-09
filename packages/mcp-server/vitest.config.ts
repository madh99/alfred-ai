import { defineConfig } from 'vitest/config';

// v1322 — wie core/cli: Worker begrenzen (Entwicklungs-PC nahe am Commit-Limit: „out of memory allocating heap arena map").
export default defineConfig({ test: { pool: 'forks', poolOptions: { forks: { maxForks: 4, minForks: 1 } } } });
