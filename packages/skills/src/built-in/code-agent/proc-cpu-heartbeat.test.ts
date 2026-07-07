import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sumProcessTreeCpuTicks } from './agent-executor.js';

/**
 * v1047 — Prozessbaum-CPU-Heartbeat: der strukturelle Fix für die
 * v844/v1046-Fehlerklasse (still laufende Builds/Tests wurden vom
 * Inactivity-Timeout gekillt, weil die Phase-Keyword-Wortliste den Fall
 * nicht kannte). Getestet gegen ein Fixture-/proc — plattformunabhängig.
 */
describe('sumProcessTreeCpuTicks (v1047)', () => {
  function makeProc(entries: Array<{ pid: number; ppid: number; comm?: string; utime: number; stime: number }>): string {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-proc-'));
    for (const e of entries) {
      mkdirSync(join(dir, String(e.pid)));
      // echtes /proc-stat-Format: pid (comm) state ppid pgrp session tty tpgid
      // flags minflt cminflt majflt cmajflt utime stime …
      const comm = e.comm ?? 'node';
      writeFileSync(
        join(dir, String(e.pid), 'stat'),
        `${e.pid} (${comm}) S ${e.ppid} 1 1 0 -1 4194304 100 0 0 0 ${e.utime} ${e.stime} 0 0 20 0 1 0 12345 1000000 500`,
      );
    }
    return dir;
  }

  it('summiert utime+stime über den GANZEN Baum (Agent + npm + vitest-Enkel)', () => {
    const dir = makeProc([
      { pid: 100, ppid: 1, comm: 'claude', utime: 10, stime: 5 },
      { pid: 200, ppid: 100, comm: 'npm test', utime: 50, stime: 20 },
      { pid: 300, ppid: 200, comm: 'vitest', utime: 400, stime: 100 },
      { pid: 999, ppid: 1, comm: 'fremd', utime: 9999, stime: 9999 }, // NICHT im Baum
    ]);
    expect(sumProcessTreeCpuTicks(100, dir)).toBe(10 + 5 + 50 + 20 + 400 + 100);
  });

  it('comm mit Klammern/Leerzeichen bricht das Parsen nicht (hinter letzter „)" parsen)', () => {
    const dir = makeProc([{ pid: 42, ppid: 1, comm: 'next build (turbo) x', utime: 7, stime: 3 }]);
    expect(sumProcessTreeCpuTicks(42, dir)).toBe(10);
  });

  it('unbekannter Root-Prozess oder fehlendes /proc → undefined (Feature still inaktiv)', () => {
    const dir = makeProc([{ pid: 100, ppid: 1, utime: 1, stime: 1 }]);
    expect(sumProcessTreeCpuTicks(12345, dir)).toBeUndefined();
    expect(sumProcessTreeCpuTicks(100, join(dir, 'gibt-es-nicht'))).toBeUndefined();
  });

  it('PPID-Zyklen führen nicht in Endlosschleife', () => {
    const dir = makeProc([
      { pid: 100, ppid: 200, utime: 1, stime: 1 },
      { pid: 200, ppid: 100, utime: 2, stime: 2 },
    ]);
    expect(sumProcessTreeCpuTicks(100, dir)).toBe(6);
  });
});
