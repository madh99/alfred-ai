import type { AgentStrategy } from '@alfred/storage';

/**
 * v889 — Zentrale CLI-Agent-Auflösung für einen Lauf.
 *
 * Eine einzige Quelle der Wahrheit, die ALLE Start-Pfade nutzen sollen
 * (Abarbeiten, Review, Discovery, Dependency, Wizard, project_agent, Sandbox).
 * Bisher fiel jeder Pfad isoliert auf `agents[0]` zurück und kannte keine
 * laufenden Läufe → parallele claude-code-Läufe konkurrierten um dasselbe
 * Subscription-Kontingent.
 *
 * Priorität:
 *   1. explizit angeforderter Agent (UI-Picker: Sandbox/Review/Discovery) — gewinnt immer
 *   2. resumeAgent (Session-Kontinuität bei Resume) — wenn verfügbar
 *   3. Strategie: auto → preferred, bei Belegung fallbackOrder durch;
 *      manual → preferred (interaktive Wahl macht der Caller), an automatischen
 *      Pfaden Fallback auf auto/preferred MIT Vermerk
 */
export interface ResolveAgentOpts {
  /** Konfigurierte CLI-Namen (codeAgents.agents[].name), in Reihenfolge. */
  available: string[];
  /** Projekt-Strategie (NULL = Default: auto, preferred = available[0]). */
  strategy?: AgentStrategy;
  /** Expliziter Picker-Wert (gewinnt, wenn gültig). */
  requestedAgent?: string;
  /** CLIs, die gerade in ANDEREN Läufen aktiv sind. */
  busy?: Set<string>;
  /** Automatischer Pfad (Cron/Reflector/Reasoning) — keine Rückfrage möglich. */
  isAutomatic?: boolean;
  /** Agent der fortzusetzenden Session (Resume) — für Kontinuität bevorzugt. */
  resumeAgent?: string;
}

export interface ResolveAgentResult {
  /** Aufgelöster CLI-Name ('' wenn keiner konfiguriert). */
  agent: string;
  /** Menschlicher Vermerk, wenn von preferred/manueller Wahl abgewichen wurde. */
  note?: string;
}

export function resolveAgentForRun(o: ResolveAgentOpts): ResolveAgentResult {
  const avail = o.available.filter(Boolean);
  if (avail.length === 0) return { agent: '' };
  const has = (a?: string): a is string => !!a && avail.includes(a);
  const busy = o.busy ?? new Set<string>();

  // 1. Expliziter Picker-Wert gewinnt immer
  if (has(o.requestedAgent)) return { agent: o.requestedAgent };

  // 2. Resume: dieselbe CLI für Session-Kontinuität (auch wenn busy — Kontinuität
  //    schlägt Last-Verteilung, sonst geht der CLI-Session-Kontext verloren)
  if (has(o.resumeAgent)) return { agent: o.resumeAgent };

  const strategy = o.strategy ?? { mode: 'auto' as const };
  const preferred = has(strategy.preferred) ? strategy.preferred : avail[0];
  const fallback = (strategy.fallbackOrder ?? avail.filter(a => a !== preferred)).filter(a => avail.includes(a) && a !== preferred);

  // 3a. manual an interaktivem Pfad: Caller erfragt die Wahl; wir liefern
  //     preferred als Vorbelegung (Resolver kann nicht selbst fragen).
  if (strategy.mode === 'manual' && !o.isAutomatic) {
    return { agent: preferred, note: 'manual: Vorauswahl — UI-Picker erwartet' };
  }

  // 3b. manual an automatischem Pfad: keine Rückfrage möglich → wie auto, vermerkt.
  const autoNotePrefix = (strategy.mode === 'manual' && o.isAutomatic)
    ? 'manuelle CLI-Wahl an automatischem Lauf nicht möglich → '
    : '';

  // auto: preferred wenn frei, sonst erste freie aus fallbackOrder
  if (!busy.has(preferred)) {
    return autoNotePrefix ? { agent: preferred, note: `${autoNotePrefix}${preferred}` } : { agent: preferred };
  }
  const free = fallback.find(a => !busy.has(a));
  if (free) {
    return { agent: free, note: `${autoNotePrefix}${preferred} läuft bereits — ausgewichen auf ${free}` };
  }
  // alle belegt → preferred, mit Hinweis
  return { agent: preferred, note: `${autoNotePrefix}alle CLIs ausgelastet — nutze ${preferred} (parallel)` };
}
