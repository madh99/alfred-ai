import { describe, it, expect } from 'vitest';
import { collectNodeMetrics } from './node-metrics.js';

/** v865 — Metrics-Collector für den Node-Heartbeat (Cluster-Seite). */
describe('collectNodeMetrics', () => {
  it('liefert plausible OS-Werte', async () => {
    const m = await collectNodeMetrics([process.cwd()]);
    expect(m.cpuCores).toBeGreaterThan(0);
    expect(m.memTotalMb).toBeGreaterThan(0);
    expect(m.memFreeMb).toBeGreaterThanOrEqual(0);
    expect(m.memFreeMb).toBeLessThanOrEqual(m.memTotalMb);
    expect(m.rssMb).toBeGreaterThan(0);
    expect(m.nodeJs).toMatch(/^v\d+/);
    expect(m.platform.length).toBeGreaterThan(0);
  });

  it('disk-Metriken: usedPct in [0,100], total > 0', async () => {
    const m = await collectNodeMetrics([process.cwd()]);
    expect(m.disks.length).toBeGreaterThanOrEqual(1);
    for (const d of m.disks) {
      expect(d.totalGb).toBeGreaterThan(0);
      expect(d.usedPct).toBeGreaterThanOrEqual(0);
      expect(d.usedPct).toBeLessThanOrEqual(100);
      expect(d.freeGb).toBeLessThanOrEqual(d.totalGb);
    }
  });

  it('dedupliziert Pfade auf demselben Filesystem', async () => {
    // cwd zweimal + Unterverzeichnis (gleiche Partition) → genau 1 Disk-Eintrag
    const m = await collectNodeMetrics([process.cwd(), process.cwd(), import.meta.dirname]);
    expect(m.disks.length).toBe(1);
    expect(m.disks[0].path).toBe(process.cwd()); // erster Pfad gewinnt
  });

  it('nicht existierende Pfade werden übersprungen, kein Throw', async () => {
    const m = await collectNodeMetrics(['/definitiv/nicht/vorhanden/xyz', process.cwd()]);
    expect(m.disks.length).toBe(1);
  });

  it('leere diskPaths-Liste → leere disks, OS-Werte trotzdem da', async () => {
    const m = await collectNodeMetrics([]);
    expect(m.disks).toEqual([]);
    expect(m.cpuCores).toBeGreaterThan(0);
  });
});
