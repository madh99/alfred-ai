import type { Logger } from 'pino';

/**
 * Jarvis Schicht 0 — Provider-Puls.
 *
 * Je LLM-Tier ein Zustand: letzter Erfolg, letzter Fehler, Fehlerklasse,
 * seit wann der Fallback greift. Gespeist aus dem Model-Router (dort entstehen
 * heute die ~70 „Provider billing failure"-Warnzeilen pro Tag). Der Puls
 * URTEILT nicht — er hält nur fest. Urteilen tut der Degradations-Wächter.
 */

export type FehlerKlasse = 'billing' | 'auth' | 'rate' | 'netz' | 'modell' | 'unbekannt';

export interface PulsEreignis {
  art: 'erfolg' | 'fehler';
  tier: string;
  provider: string;
  model: string;
  klasse?: FehlerKlasse;
  fehler?: string;
}

export interface TierPuls {
  tier: string;
  provider: string;
  model: string;
  letzterErfolg?: string;   // ISO
  letzterFehler?: string;   // ISO
  fehlerKlasse?: FehlerKlasse;
  fehlerText?: string;
  /** Seit wann der Tier durchgehend fehlschlägt (erster Fehler nach letztem Erfolg). */
  gestoertSeit?: string;
  erfolge: number;
  fehler: number;
  updatedAt: string;
}

export interface PulsPersistenz {
  speichere(p: TierPuls): Promise<void>;
  ladeAlle(): Promise<TierPuls[]>;
}

export class ProviderPuls {
  private readonly tiers = new Map<string, TierPuls>();
  private schreibTimer?: ReturnType<typeof setTimeout>;
  private dirty = new Set<string>();

  constructor(private readonly logger: Logger, private readonly persistenz?: PulsPersistenz, private readonly now: () => Date = () => new Date()) {}

  /**
   * Gespeicherten Zustand übernehmen (Restart darf einen Vorfall nicht „heilen").
   * Wird NACH den Migrationen gerufen (v1163: beim ersten Start nach einer
   * Migration existierte die Tabelle noch nicht). Ereignisse, die bis dahin
   * schon im Speicher liegen, werden mit dem gespeicherten Stand verschmolzen:
   * Zähler addiert, „gestört seit" aus der Historie, wenn seither kein Erfolg kam.
   */
  async lade(): Promise<void> {
    if (!this.persistenz) return;
    try {
      for (const alt of await this.persistenz.ladeAlle()) {
        const neu = this.tiers.get(alt.tier);
        if (!neu) { this.tiers.set(alt.tier, alt); continue; }
        neu.erfolge += alt.erfolge; neu.fehler += alt.fehler;
        if (alt.letzterErfolg && (!neu.letzterErfolg || alt.letzterErfolg > neu.letzterErfolg)) neu.letzterErfolg = alt.letzterErfolg;
        if (alt.letzterFehler && (!neu.letzterFehler || alt.letzterFehler > neu.letzterFehler)) neu.letzterFehler = alt.letzterFehler;
        const seitStartKeinErfolg = !neu.letzterErfolg || (alt.gestoertSeit !== undefined && neu.letzterErfolg < alt.gestoertSeit);
        if (ProviderPuls.istGestoert(neu) && alt.gestoertSeit && seitStartKeinErfolg) neu.gestoertSeit = alt.gestoertSeit;
        this.markiere(alt.tier);
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Lebenszeichen: Provider-Puls konnte nicht geladen werden');
    }
  }

  verarbeite(ev: PulsEreignis): TierPuls {
    const jetzt = this.now().toISOString();
    const p: TierPuls = this.tiers.get(ev.tier) ?? { tier: ev.tier, provider: ev.provider, model: ev.model, erfolge: 0, fehler: 0, updatedAt: jetzt };
    p.provider = ev.provider; p.model = ev.model; p.updatedAt = jetzt;
    if (ev.art === 'erfolg') {
      p.letzterErfolg = jetzt; p.erfolge++;
      p.gestoertSeit = undefined; p.fehlerKlasse = undefined; p.fehlerText = undefined;
    } else {
      p.letzterFehler = jetzt; p.fehler++;
      p.fehlerKlasse = ev.klasse ?? 'unbekannt'; p.fehlerText = ev.fehler;
      if (!p.gestoertSeit) p.gestoertSeit = jetzt;
    }
    this.tiers.set(ev.tier, p);
    this.markiere(ev.tier);
    return p;
  }

  zustand(tier: string): TierPuls | undefined { return this.tiers.get(tier); }
  alle(): TierPuls[] { return [...this.tiers.values()].sort((a, b) => a.tier.localeCompare(b.tier)); }

  /** Gestört = letzter Fehler jünger als letzter Erfolg. */
  static istGestoert(p: TierPuls): boolean {
    if (!p.letzterFehler) return false;
    if (!p.letzterErfolg) return true;
    return p.letzterFehler > p.letzterErfolg;
  }

  /** Persistenz gebündelt (max. 1 Schreibvorgang je Tier pro 30 s — Puls-Ereignisse kommen im Sekundentakt). */
  private markiere(tier: string): void {
    if (!this.persistenz) return;
    this.dirty.add(tier);
    if (this.schreibTimer) return;
    this.schreibTimer = setTimeout(() => { void this.schreibe(); }, 30_000);
    (this.schreibTimer as { unref?: () => void }).unref?.();
  }

  async schreibe(): Promise<void> {
    if (this.schreibTimer) { clearTimeout(this.schreibTimer); this.schreibTimer = undefined; }
    if (!this.persistenz) return;
    const keys = [...this.dirty]; this.dirty.clear();
    for (const k of keys) {
      const p = this.tiers.get(k);
      if (p) await this.persistenz.speichere(p).catch(err => this.logger.debug({ err: (err as Error).message, tier: k }, 'Lebenszeichen: Puls-Schreiben fehlgeschlagen'));
    }
  }
}
