import type { JobTakt } from './job-register.js';
import type { FehlerKlasse } from './provider-puls.js';

/**
 * Jarvis Schicht 0 — Synthetische Proben (täglich 06:50, vor dem Morgen-Bündel).
 *
 * Kleine, kostenneutrale Checks, die Ausfälle sichtbar machen, bevor sie
 * wehtun: je Tier ein Minimal-Request OHNE Fallback (misst Verfügbarkeit und
 * Guthaben), je registriertem Job „lief er innerhalb seines Takts?" (aus
 * job_runs — Realfall 12.–28.09.: KG-Wartung 16 Tage tot) und die Frische der
 * Kerntabellen. Die Proben URTEILEN deterministisch; gemeldet wird über den
 * Degradations-Wächter.
 */

export interface AdapterZustand { platform: string; status: string; getrenntSeitMs?: number }

export interface ProbeErgebnis {
  art: 'tier' | 'job' | 'daten' | 'adapter';
  name: string;
  ok: boolean;
  detail: string;
  klasse?: FehlerKlasse;
}

export interface ProbenDeps {
  tiers?: {
    konfigurierteTiers(): string[];
    probeTier(tier: string): Promise<{ ok: boolean; provider: string; model: string; klasse?: FehlerKlasse; fehler?: string; dauerMs: number }>;
  };
  /** Embedding-Probe (eigener Pfad, kein Chat-Request). */
  embed?: () => Promise<unknown>;
  jobs: () => Array<{ key: string; takt: JobTakt; beschreibung: string }>;
  registerGestartetAm?: string;
  letzterLauf: (key: string) => Promise<{ startedAt: string; ok?: boolean } | undefined>;
  juengsteZeit?: (tabelle: 'activity_log' | 'llm_usage' | 'alfred_insights' | 'messwerte') => Promise<string | undefined>;
  /** Jobs, die nicht geprobt werden (z. B. die Probe selbst). */
  ausgenommen?: string[];
  /** v1191 — Messaging-Adapter, die verbunden sein sollen (Realfall 05.10.: Matrix-Homeserver 502, Adapter den ganzen Tag tot, niemand gemeldet). */
  adapter?: () => AdapterZustand[];
  now?: () => Date;
}

/** Spielraum, innerhalb dessen ein Job gelaufen sein muss: ein Takt plus Reserve. */
export function erwarteteFristMs(takt: JobTakt): number {
  if (takt.art === 'taeglich') return 26 * 3600_000;
  if (takt.art === 'woechentlich') return 8 * 86_400_000;
  return Math.max(30 * 60_000, 2 * takt.minuten * 60_000);
}

export function formatiereDauer(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} Tage`;
}

const DATEN_FRISTEN: Record<'activity_log' | 'llm_usage' | 'alfred_insights' | 'messwerte', number> = {
  activity_log: 24 * 3600_000,
  llm_usage: 48 * 3600_000,     // Tagesgranularität (date)
  alfred_insights: 3 * 86_400_000,
  messwerte: 3 * 3600_000,      // v1192 — Sammler alle 30 min (Schicht-1-Datenbasis); 3 h = 6 verpasste Läufe
};

export async function fuehreProbenAus(deps: ProbenDeps): Promise<ProbeErgebnis[]> {
  const now = (deps.now ?? (() => new Date()))();
  const ergebnisse: ProbeErgebnis[] = [];

  // 1) Tiers — direkt, ohne Fallback-Kette
  if (deps.tiers) {
    for (const tier of deps.tiers.konfigurierteTiers()) {
      if (tier === 'embeddings') continue;
      const r = await deps.tiers.probeTier(tier);
      ergebnisse.push({
        art: 'tier', name: tier, ok: r.ok, klasse: r.klasse,
        detail: r.ok ? `${r.provider}/${r.model} antwortet (${r.dauerMs} ms)` : `${r.provider}/${r.model}: ${r.klasse ?? 'fehler'} — ${(r.fehler ?? '').slice(0, 120)}`,
      });
    }
  }
  if (deps.embed) {
    try { await deps.embed(); ergebnisse.push({ art: 'tier', name: 'embeddings', ok: true, detail: 'Embedding-Provider antwortet' }); }
    catch (err) { ergebnisse.push({ art: 'tier', name: 'embeddings', ok: false, klasse: 'unbekannt', detail: `Embedding fehlgeschlagen — ${((err as Error).message ?? '').slice(0, 120)}` }); }
  }

  // 2) Jobs — lief jeder innerhalb seines Takts?
  const ausgenommen = new Set(deps.ausgenommen ?? []);
  for (const job of deps.jobs()) {
    if (ausgenommen.has(job.key)) continue;
    const frist = erwarteteFristMs(job.takt);
    const lauf = await deps.letzterLauf(job.key);
    if (!lauf) {
      const seitStart = deps.registerGestartetAm ? now.getTime() - Date.parse(deps.registerGestartetAm) : Infinity;
      const faellig = seitStart > frist;
      ergebnisse.push({ art: 'job', name: job.key, ok: !faellig, detail: faellig ? `noch kein Lauf seit Registrierung vor ${formatiereDauer(seitStart)}` : 'noch kein Lauf fällig' });
      continue;
    }
    const alter = now.getTime() - Date.parse(lauf.startedAt);
    if (alter > frist) {
      ergebnisse.push({ art: 'job', name: job.key, ok: false, detail: `letzter Lauf vor ${formatiereDauer(alter)} (erwartet innerhalb ${formatiereDauer(frist)})` });
    } else if (lauf.ok === false) {
      ergebnisse.push({ art: 'job', name: job.key, ok: false, detail: `letzter Lauf vor ${formatiereDauer(alter)} fehlgeschlagen` });
    } else {
      ergebnisse.push({ art: 'job', name: job.key, ok: true, detail: `letzter Lauf vor ${formatiereDauer(alter)}` });
    }
  }

  // 3) Daten-Frische
  if (deps.juengsteZeit) {
    for (const tabelle of Object.keys(DATEN_FRISTEN) as Array<keyof typeof DATEN_FRISTEN>) {
      try {
        const t = await deps.juengsteZeit(tabelle);
        if (!t) { ergebnisse.push({ art: 'daten', name: tabelle, ok: false, detail: 'keine Zeile' }); continue; }
        const alter = now.getTime() - Date.parse(t);
        const ok = alter <= DATEN_FRISTEN[tabelle];
        ergebnisse.push({ art: 'daten', name: tabelle, ok, detail: `jüngste Zeile vor ${formatiereDauer(alter)}` });
      } catch (err) {
        ergebnisse.push({ art: 'daten', name: tabelle, ok: false, detail: `Abfrage fehlgeschlagen — ${((err as Error).message ?? '').slice(0, 120)}` });
      }
    }
  }

  // 4) Adapter — verbunden oder nicht (v1191)
  if (deps.adapter) {
    for (const a of deps.adapter()) {
      const ok = a.status === 'connected';
      const seit = a.getrenntSeitMs ? ` seit ${formatiereDauer(now.getTime() - a.getrenntSeitMs)}` : '';
      ergebnisse.push({ art: 'adapter', name: a.platform, ok, detail: ok ? 'verbunden' : `nicht verbunden (${a.status})${seit}` });
    }
  }

  return ergebnisse;
}
