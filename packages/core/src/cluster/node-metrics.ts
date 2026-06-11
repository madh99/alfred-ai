/**
 * v865 — System-Metriken pro Cluster-Node für die Cluster-Seite.
 *
 * Sammelt OS-Infos (CPU-Load, RAM), Prozess-RSS und Disk-Belegung via
 * fs.statfs (Node-builtin, kein externes Paket). Wird vom Heartbeat
 * (cluster-manager) alle ~10s aufgerufen und als JSON in
 * node_heartbeats.metrics persistiert; im Single-Node-Modus direkt
 * von getHealth (alfred.ts) für den synthetischen Node-Eintrag.
 */
import os from 'node:os';
import { statfs } from 'node:fs/promises';

export interface DiskMetric {
  path: string;
  totalGb: number;
  freeGb: number;
  usedPct: number;
}

export interface NodeMetrics {
  cpuLoad1m: number;
  cpuCores: number;
  memTotalMb: number;
  memFreeMb: number;
  /** RSS des Alfred-Prozesses in MB. */
  rssMb: number;
  nodeJs: string;
  platform: string;
  osRelease: string;
  disks: DiskMetric[];
}

/**
 * Sammelt Metriken. diskPaths dürfen Dateien sein (statfs liefert das
 * enthaltende Filesystem); nicht existierende Pfade werden übersprungen,
 * mehrere Pfade auf demselben Filesystem dedupliziert (erster gewinnt).
 */
export async function collectNodeMetrics(diskPaths: string[]): Promise<NodeMetrics> {
  const disks: DiskMetric[] = [];
  const seenFs = new Set<string>();
  for (const p of diskPaths) {
    if (!p) continue;
    try {
      const s = await statfs(p);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      if (total <= 0) continue;
      // Dedupe: gleiche FS-Größe + gleicher Freiraum innerhalb EINES Sammel-
      // Durchlaufs = mit sehr hoher Wahrscheinlichkeit dasselbe Filesystem
      // (z.B. '/' und './data' auf derselben Partition).
      const fsKey = `${total}:${Number(s.bfree)}:${Number(s.type)}`;
      if (seenFs.has(fsKey)) continue;
      seenFs.add(fsKey);
      disks.push({
        path: p,
        totalGb: round1(total / 1024 ** 3),
        freeGb: round1(free / 1024 ** 3),
        usedPct: Math.min(100, Math.max(0, Math.round((1 - free / total) * 100))),
      });
    } catch { /* Pfad existiert nicht / kein Zugriff — überspringen */ }
  }

  return {
    cpuLoad1m: round1(os.loadavg()[0] ?? 0),
    cpuCores: os.cpus().length,
    memTotalMb: Math.round(os.totalmem() / 1024 ** 2),
    memFreeMb: Math.round(os.freemem() / 1024 ** 2),
    rssMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
    nodeJs: process.version,
    platform: os.platform(),
    osRelease: os.release(),
    disks,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
