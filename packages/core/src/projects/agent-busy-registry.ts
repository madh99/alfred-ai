/**
 * v889 — Globales In-Memory-Register laufender CLI-Agent-Läufe (HA-lokal pro Node).
 *
 * Hintergrund: Es gibt keinen einzigen DB-Ort, der ALLE laufenden CLI-Agents
 * kennt — `project_agent_sessions` erfasst nur Project-Agent-Läufe, NICHT die
 * `runCodeAgent`-Pfade (Abarbeiten, Review, Feature-Discovery, Dependency).
 * Dieses Register ist die einzige Quelle, die jeden Lauftyp sieht: jeder Start
 * registriert sich, jedes Ende meldet sich ab. Damit kann der Resolver
 * entscheiden, ob eine CLI gerade belegt ist (Kontingent-Konkurrenz vermeiden).
 *
 * Bewusst in-memory + node-lokal: Es geht um die Last AUF DIESER Node; ein
 * Cluster-weites Register wäre über-engineered (CLIs laufen lokal pro Node).
 */
export interface BusyEntry {
  cli: string;
  projectId: string;
  kind: string;
  startedAt: number;
}

export class AgentBusyRegistry {
  private readonly active = new Map<string, BusyEntry>();
  private seq = 0;

  /** Registriert einen startenden Lauf, liefert ein Release-Token. */
  register(cli: string, projectId: string, kind: string, now: number): string {
    const token = `${cli}:${++this.seq}`;
    this.active.set(token, { cli, projectId, kind, startedAt: now });
    return token;
  }

  /** Meldet einen Lauf ab (idempotent). */
  release(token: string): void {
    this.active.delete(token);
  }

  /** Namen der CLIs, die gerade mindestens einen Lauf haben. */
  busyClis(): Set<string> {
    return new Set([...this.active.values()].map(e => e.cli));
  }

  /** Läuft diese CLI gerade — optional: in einem ANDEREN als dem gegebenen Projekt? */
  isBusy(cli: string, exceptProjectId?: string): boolean {
    for (const e of this.active.values()) {
      if (e.cli !== cli) continue;
      if (exceptProjectId && e.projectId === exceptProjectId) continue;
      return true;
    }
    return false;
  }

  /** Detail für UI/Logs: welche CLI in welchem Projekt mit welcher Art Lauf. */
  snapshot(): BusyEntry[] {
    return [...this.active.values()].sort((a, b) => a.startedAt - b.startedAt);
  }
}
