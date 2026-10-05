import type { AsyncDbAdapter } from '../db-adapter.js';

/**
 * Jarvis Schicht 0 — Persistenz für Provider-Puls und Wächter-Meldungen.
 *
 * provider_puls: eine Zeile je Tier (Zustand überlebt Restarts — ein Neustart
 * darf einen Guthaben-Vorfall nicht „heilen").
 * lebenszeichen_meldungen: je Meldungs-Schlüssel, seit wann der Zustand offen
 * ist und wann zuletzt gemeldet wurde (höchstens täglich; Entwarnung einmalig).
 */

export interface ProviderPulsRow {
  tier: string;
  provider: string;
  model: string;
  letzterErfolg?: string;
  letzterFehler?: string;
  fehlerKlasse?: 'billing' | 'auth' | 'rate' | 'netz' | 'modell' | 'unbekannt';
  fehlerText?: string;
  gestoertSeit?: string;
  erfolge: number;
  fehler: number;
  updatedAt: string;
}

export interface MeldungRow {
  key: string;
  offenSeit: string;
  zuletztGemeldet?: string;
  text?: string;
}

export class LebenszeichenRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async speicherePuls(p: ProviderPulsRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO provider_puls (tier, provider, model, letzter_erfolg, letzter_fehler, fehler_klasse, fehler_text, gestoert_seit, erfolge, fehler, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tier) DO UPDATE SET provider = excluded.provider, model = excluded.model, letzter_erfolg = excluded.letzter_erfolg,
         letzter_fehler = excluded.letzter_fehler, fehler_klasse = excluded.fehler_klasse, fehler_text = excluded.fehler_text,
         gestoert_seit = excluded.gestoert_seit, erfolge = excluded.erfolge, fehler = excluded.fehler, updated_at = excluded.updated_at`,
      [p.tier, p.provider, p.model, p.letzterErfolg ?? null, p.letzterFehler ?? null, p.fehlerKlasse ?? null, p.fehlerText ?? null, p.gestoertSeit ?? null, p.erfolge, p.fehler, p.updatedAt],
    );
  }

  async ladePuls(): Promise<ProviderPulsRow[]> {
    const rows = await this.db.query('SELECT * FROM provider_puls ORDER BY tier', []) as Record<string, unknown>[];
    return rows.map(r => ({
      tier: r.tier as string, provider: r.provider as string, model: r.model as string,
      letzterErfolg: (r.letzter_erfolg as string | null) ?? undefined,
      letzterFehler: (r.letzter_fehler as string | null) ?? undefined,
      fehlerKlasse: (r.fehler_klasse as ProviderPulsRow['fehlerKlasse'] | null) ?? undefined,
      fehlerText: (r.fehler_text as string | null) ?? undefined,
      gestoertSeit: (r.gestoert_seit as string | null) ?? undefined,
      erfolge: Number(r.erfolge ?? 0), fehler: Number(r.fehler ?? 0),
      updatedAt: r.updated_at as string,
    }));
  }

  async ladeMeldungen(): Promise<MeldungRow[]> {
    const rows = await this.db.query('SELECT * FROM lebenszeichen_meldungen', []) as Record<string, unknown>[];
    return rows.map(r => ({
      key: r.key as string, offenSeit: r.offen_seit as string,
      zuletztGemeldet: (r.zuletzt_gemeldet as string | null) ?? undefined,
      text: (r.text as string | null) ?? undefined,
    }));
  }

  async speichereMeldung(m: MeldungRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO lebenszeichen_meldungen (key, offen_seit, zuletzt_gemeldet, text) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET offen_seit = excluded.offen_seit, zuletzt_gemeldet = excluded.zuletzt_gemeldet, text = excluded.text`,
      [m.key, m.offenSeit, m.zuletztGemeldet ?? null, m.text ?? null],
    );
  }

  async loescheMeldung(key: string): Promise<void> {
    await this.db.execute('DELETE FROM lebenszeichen_meldungen WHERE key = ?', [key]);
  }

  /** Jüngste Zeile einer Tabelle nach Zeitspalte — für die Freshness-Proben. */
  async juengsteZeit(tabelle: 'activity_log' | 'llm_usage' | 'alfred_insights' | 'messwerte'): Promise<string | undefined> {
    const spalte = tabelle === 'activity_log' ? 'timestamp' : tabelle === 'llm_usage' ? 'date' : tabelle === 'messwerte' ? 'gemessen_at' : 'created_at';
    const row = await this.db.queryOne(`SELECT MAX(${spalte}) AS t FROM ${tabelle}`, []) as { t?: string | null } | undefined;
    return row?.t ?? undefined;
  }
}
