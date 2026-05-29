import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoDetectBuildCommands } from './project-agent-skill.js';

/**
 * v809 — Tests für die dev-safe Build-Command-Wahl.
 *
 * Hintergrund: Plan-Mode aus dem Sandbox-Chat lief `npm run build` auf dem Host
 * im Worktree → überschrieb das .next des Container-dev-servers → Build-Crash →
 * "Fix-Versuch". Der Fix erkennt den Sandbox-Kontext (via sandbox_id) und nutzt
 * dev-safe Commands (typecheck/lint + optional HTTP-Check) statt `npm run build`.
 */

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-autodetect-'));
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: {
        build: 'next build',
        typecheck: 'tsc --noEmit',
        lint: 'next lint',
        test: 'vitest run',
        dev: 'next dev',
      },
    }),
  );
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('autoDetectBuildCommands — normaler Projekt-Run (devSafe=false)', () => {
  it('enthält npm install + npm run build (destruktiver Voll-Build)', async () => {
    const r = await autoDetectBuildCommands(tmpDir);
    expect(r).not.toBeNull();
    expect(r!.build).toContain('npm install');
    expect(r!.build).toContain('npm run build');
    expect(r!.build).toContain('npm run typecheck');
    expect(r!.build).toContain('npm run lint');
  });
});

describe('autoDetectBuildCommands — Sandbox-Worktree pausiert (devSafe=true, kein runningSandbox)', () => {
  it('überspringt npm install UND npm run build', async () => {
    const r = await autoDetectBuildCommands(tmpDir, { devSafe: true });
    expect(r).not.toBeNull();
    expect(r!.build).not.toContain('npm install');
    expect(r!.build).not.toContain('npm run build');
  });

  it('behält typecheck, aber NICHT lint (v810: kein --max-warnings-0 Scope-Creep)', async () => {
    const r = await autoDetectBuildCommands(tmpDir, { devSafe: true });
    expect(r!.build).toContain('npm run typecheck');
    expect(r!.build).not.toContain('npm run lint');
  });

  it('fügt keinen curl-Health-Check hinzu wenn kein dev-server läuft', async () => {
    const r = await autoDetectBuildCommands(tmpDir, { devSafe: true });
    expect(r!.build.some(c => c.startsWith('curl'))).toBe(false);
  });
});

describe('autoDetectBuildCommands — Sandbox läuft (runningSandbox gesetzt)', () => {
  it('v811: nur typecheck, KEIN build/install/curl (dev-server-Liveness kein Gate)', async () => {
    const r = await autoDetectBuildCommands(tmpDir, { runningSandbox: { hostPort: 31234 }, devSafe: true });
    expect(r!.build).not.toContain('npm run build');
    expect(r!.build).not.toContain('npm install');
    expect(r!.build).toContain('npm run typecheck');
    // v811 — curl entfernt: fragile dev-server-Liveness löste unfixbare Fix-Versuche aus
    expect(r!.build.some(c => c.includes('curl'))).toBe(false);
  });

  it('runningSandbox impliziert devSafe auch ohne explizites Flag', async () => {
    const r = await autoDetectBuildCommands(tmpDir, { runningSandbox: { hostPort: 8080 } });
    expect(r!.build).not.toContain('npm run build');
    expect(r!.build).not.toContain('npm install');
  });
});

describe('Regression — Fix-Versuch-Ursache', () => {
  it('Sandbox-Kontext erzeugt NIE npm run build (Quelle der .next-Kollision)', async () => {
    const paused = await autoDetectBuildCommands(tmpDir, { devSafe: true });
    const running = await autoDetectBuildCommands(tmpDir, { runningSandbox: { hostPort: 3000 }, devSafe: true });
    expect(paused!.build).not.toContain('npm run build');
    expect(running!.build).not.toContain('npm run build');
  });

  it('v811: Sandbox-Kontext erzeugt NIE curl/lint (fragile/Scope-Creep Fix-Versuch-Quellen)', async () => {
    const paused = await autoDetectBuildCommands(tmpDir, { devSafe: true });
    const running = await autoDetectBuildCommands(tmpDir, { runningSandbox: { hostPort: 3000 }, devSafe: true });
    for (const r of [paused!, running!]) {
      expect(r.build.some(c => c.includes('curl'))).toBe(false);
      expect(r.build).not.toContain('npm run lint');
      // typecheck bleibt das einzige verlässliche per-Phase-Gate
      expect(r.build).toContain('npm run typecheck');
    }
  });

  it('v813: Sandbox-Kontext erzeugt KEINE Tests (musl/glibc ABI-Konflikt im Bind-Mount)', async () => {
    const paused = await autoDetectBuildCommands(tmpDir, { devSafe: true });
    const running = await autoDetectBuildCommands(tmpDir, { runningSandbox: { hostPort: 3000 }, devSafe: true });
    expect(paused!.test).toEqual([]);
    expect(running!.test).toEqual([]);
  });

  it('v813: Nicht-devSafe (klassischer Run) hat npm test weiterhin', async () => {
    const r = await autoDetectBuildCommands(tmpDir);
    expect(r!.test).toContain('npm test');
  });
});
