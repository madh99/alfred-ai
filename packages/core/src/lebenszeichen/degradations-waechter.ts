import type { Logger } from 'pino';
import { ProviderPuls, type TierPuls } from './provider-puls.js';
import type { ProbeErgebnis } from './proben.js';
import { formatiereDauer } from './proben.js';
import { lokalesDatum } from '../nachtjob-plan.js';

/**
 * Jarvis Schicht 0 — Degradations-Wächter.
 *
 * Deterministische Regeln über Provider-Puls und Proben → genau EIN Satz je
 * Zustand an den Owner, Wiederholung höchstens täglich (im Morgen-Lauf),
 * Entwarnung einmalig. KEIN Modell-Gate, keine Pause: Alfred arbeitet mit
 * dem Fallback weiter (Architektur-Grundsatz) — er sagt es nur.
 *
 * Ersetzt die v868-Billing-Alerts (6-h-Dedupe je Tier → 12 Owner-Nachrichten
 * pro Tag während des Anthropic-/OpenAI-Guthaben-Vorfalls seit 18.08.).
 */

export interface Befund { key: string; text: string }
export interface Meldung { key: string; art: 'warnung' | 'entwarnung'; text: string }

interface OffenerZustand { offenSeit: string; zuletztGemeldet?: string; text: string }

export interface WaechterPersistenz {
  ladeMeldungen(): Promise<Array<{ key: string; offenSeit: string; zuletztGemeldet?: string; text?: string }>>;
  speichereMeldung(m: { key: string; offenSeit: string; zuletztGemeldet?: string; text?: string }): Promise<void>;
  loescheMeldung(key: string): Promise<void>;
}

export const DEGRADATION_SCHWELLE_MS = 60 * 60_000;
/** Tiers, deren Ausfall unabhängig von der Fehlerklasse gemeldet wird. */
const KERN_TIERS = new Set(['default', 'strong']);

function datumKurz(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

/** Regel 1+2: Provider-Zustände → Befunde. Rein, testbar. */
export function bewertePuls(puls: TierPuls[], now: Date): Befund[] {
  const befunde: Befund[] = [];
  for (const p of puls) {
    if (!ProviderPuls.istGestoert(p) || !p.gestoertSeit) continue;
    const dauer = now.getTime() - Date.parse(p.gestoertSeit);
    if (dauer < DEGRADATION_SCHWELLE_MS) continue;
    const billing = p.fehlerKlasse === 'billing';
    if (!billing && !KERN_TIERS.has(p.tier)) continue;
    const letzterErfolg = p.letzterErfolg ? `letzter Erfolg ${datumKurz(p.letzterErfolg)}` : 'noch kein Erfolg seit Start';
    const text = billing
      ? `Seit ${datumKurz(p.gestoertSeit)} ohne ${p.provider}-Guthaben (Tier ${p.tier}, ${p.model}) — läuft über den Fallback, ${letzterErfolg}`
      : `Tier ${p.tier} (${p.provider}/${p.model}) seit ${formatiereDauer(dauer)} nicht erreichbar (${p.fehlerKlasse ?? 'fehler'}) — läuft über den Fallback, ${letzterErfolg}`;
    befunde.push({ key: `tier:${p.tier}`, text });
  }
  return befunde;
}

/** Regel 3: Proben → Befunde (Jobs überfällig, Daten stehen). Tier-Proben fließen über den Puls. */
export function bewerteProben(proben: ProbeErgebnis[]): Befund[] {
  const befunde: Befund[] = [];
  for (const p of proben) {
    if (p.ok || p.art === 'tier') continue;
    befunde.push({
      key: `${p.art}:${p.name}`,
      text: p.art === 'job' ? `Job ${p.name}: ${p.detail}` : `Tabelle ${p.name}: ${p.detail}`,
    });
  }
  return befunde;
}

export class DegradationsWaechter {
  private readonly offen = new Map<string, OffenerZustand>();

  constructor(private readonly deps: { logger: Logger; persistenz?: WaechterPersistenz; now?: () => Date }) {}

  async lade(): Promise<void> {
    if (!this.deps.persistenz) return;
    try {
      for (const m of await this.deps.persistenz.ladeMeldungen()) this.offen.set(m.key, { offenSeit: m.offenSeit, zuletztGemeldet: m.zuletztGemeldet, text: m.text ?? '' });
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message }, 'Lebenszeichen: Wächter-Zustand konnte nicht geladen werden');
    }
  }

  offeneZustaende(): Array<{ key: string } & OffenerZustand> {
    return [...this.offen.entries()].map(([key, z]) => ({ key, ...z }));
  }

  /**
   * Befunde mit dem offenen Zustand abgleichen.
   * - neuer Befund → Warnung (sofort)
   * - bestehender Befund → Warnung nur mit `wiederholen` und höchstens einmal je Tag
   * - verschwundener Befund → einmalige Entwarnung
   * Ein Befund für `nurBereiche` wird nur in diesen Bereichen abgeglichen (der
   * 10-min-Lauf kennt nur den Puls und darf Job-Befunde nicht entwarnen).
   */
  async abgleich(befunde: Befund[], opts: { wiederholen: boolean; nurBereiche?: string[] } = { wiederholen: false }): Promise<Meldung[]> {
    const now = (this.deps.now ?? (() => new Date()))();
    const heute = lokalesDatum(now);
    const jetzt = now.toISOString();
    const meldungen: Meldung[] = [];
    const aktuell = new Map(befunde.map(b => [b.key, b]));
    const imBereich = (key: string) => !opts.nurBereiche || opts.nurBereiche.some(b => key.startsWith(`${b}:`));

    for (const b of befunde) {
      const z = this.offen.get(b.key);
      if (!z) {
        const neu: OffenerZustand = { offenSeit: jetzt, zuletztGemeldet: jetzt, text: b.text };
        this.offen.set(b.key, neu);
        meldungen.push({ key: b.key, art: 'warnung', text: b.text });
        await this.deps.persistenz?.speichereMeldung({ key: b.key, ...neu }).catch(() => undefined);
        continue;
      }
      z.text = b.text;
      const heuteSchon = z.zuletztGemeldet ? lokalesDatum(new Date(z.zuletztGemeldet)) === heute : false;
      if (opts.wiederholen && !heuteSchon) {
        z.zuletztGemeldet = jetzt;
        meldungen.push({ key: b.key, art: 'warnung', text: `${b.text} (seit ${datumKurz(z.offenSeit)})` });
        await this.deps.persistenz?.speichereMeldung({ key: b.key, ...z }).catch(() => undefined);
      }
    }

    for (const [key, z] of [...this.offen.entries()]) {
      if (aktuell.has(key) || !imBereich(key)) continue;
      this.offen.delete(key);
      meldungen.push({ key, art: 'entwarnung', text: `${beschreibeKey(key)} wieder in Ordnung (war offen seit ${datumKurz(z.offenSeit)})` });
      await this.deps.persistenz?.loescheMeldung(key).catch(() => undefined);
    }
    return meldungen;
  }
}

function beschreibeKey(key: string): string {
  const [art, name] = key.split(':');
  if (art === 'tier') return `Tier ${name}`;
  if (art === 'job') return `Job ${name}`;
  if (art === 'daten') return `Tabelle ${name}`;
  return key;
}

/** Genau eine Owner-Nachricht aus mehreren Meldungen — eine Zeile Warnung, eine Zeile Entwarnung. */
export function formatiereMeldungen(meldungen: Meldung[]): string | undefined {
  const warn = meldungen.filter(m => m.art === 'warnung').map(m => m.text);
  const ok = meldungen.filter(m => m.art === 'entwarnung').map(m => m.text);
  const zeilen: string[] = [];
  if (warn.length) zeilen.push(`⚠️ ${warn.join(' · ')}`);
  if (ok.length) zeilen.push(`✅ ${ok.join(' · ')}`);
  return zeilen.length ? zeilen.join('\n') : undefined;
}
