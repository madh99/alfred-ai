import net from 'node:net';
import type { SandboxRepository } from '@alfred/storage';

/**
 * v697 — Findet einen freien Host-Port im konfigurierten Range.
 * Prüft Reihenfolge:
 *  1. Port nicht in DB als aktive Sandbox eingetragen
 *  2. Port frei am OS (TCP-Bind-Test)
 *
 * Race-Condition zwischen DB-Check und OS-Bind: Allokation passiert atomar in
 * `SandboxManager.createForSession` durch DB-Insert mit Port, dann erst docker run.
 * Sollte ein anderer Prozess währenddessen den Port grabben → docker run failed
 * → wir versuchen den nächsten Port (max 5 Versuche).
 */
export async function findFreePort(rangeStart: number, rangeEnd: number, repo: SandboxRepository): Promise<number> {
  // Belegte Ports aus DB sammeln
  const occupied = new Set<number>();
  // Iteriere über alle running/creating/paused — die haben einen host_port reserviert
  // Vereinfacht: hole alle aktiven Sandboxes über repo (würde idealerweise eine
  // listAllActive() Method haben — fürs erste reicht Brute-Force über bekannte States)
  // Da SandboxRepository.listByNodeAndStatus existiert, holen wir alle aktiven aller Nodes:
  for (const status of ['creating', 'running', 'paused'] as const) {
    const sandboxes = await repo.listIdleSince(new Date(Date.now() + 86400_000).toISOString(), [status]);
    for (const s of sandboxes) {
      if (typeof s.hostPort === 'number') occupied.add(s.hostPort);
    }
  }

  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (occupied.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range ${rangeStart}-${rangeEnd} (${occupied.size} occupied)`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '0.0.0.0');
  });
}
