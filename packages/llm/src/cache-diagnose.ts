/**
 * v1693 (K2, Spec 2026-10-27-kosten-infra-planung) — Cache-Diagnose je Anfrage, reine Messung: Anthropic
 * `diagnostics.previous_message_id`, OpenAI-Responses `prompt_cache_options.comparison_response_id`. Beide Anbieter
 * vergleichen die Anfrage mit der vorigen desselben Gesprächs und nennen den ersten Abweichungsgrund. Kostenlos,
 * ändert weder Caching noch Ausgabe. Lehnt eine API den Parameter ab, wird ohne ihn wiederholt und die Diagnose für
 * diesen Provider abgeschaltet — die Messung darf nie eine Antwort verhindern.
 */
import type { CacheDiagnose } from '@alfred/types';

/** Letzte Antwort-ID je Gespräch (je Provider-Instanz = je Modell), begrenzt */
export class DiagnoseKette {
  private readonly letzte = new Map<string, string>();
  aus = /^(aus|off|0|false|nein)$/i.test(process.env.ALFRED_CACHE_DIAGNOSE ?? '');
  constructor(private readonly max = 500) {}
  aktiv(schluessel: string | undefined): schluessel is string { return !this.aus && !!schluessel; }
  vorher(schluessel: string): string | null { return this.letzte.get(schluessel) ?? null; }
  merke(schluessel: string | undefined, id: string | undefined): void {
    if (!schluessel || !id) return;
    this.letzte.delete(schluessel); this.letzte.set(schluessel, id);
    if (this.letzte.size > this.max) this.letzte.delete(this.letzte.keys().next().value!);
  }
}

/** Hat die API den Diagnose-Parameter abgelehnt (400 mit dem Feldnamen in der Meldung)? */
export function istDiagnoseAblehnung(err: unknown, feld: string): boolean {
  const status = (err as { status?: number })?.status;
  const text = String((err as { message?: string })?.message ?? err ?? '');
  return status === 400 && text.includes(feld);
}

const zahl = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Anthropic: `diagnostics` der Antwort; mitVorher = es wurde eine echte previous_message_id gesendet */
export function anthropicDiagnose(roh: unknown, mitVorher: boolean): CacheDiagnose {
  if (!mitVorher) return { ergebnis: 'erster' };
  if (roh === null || roh === undefined) return { ergebnis: 'treffer' }; // verglichen, keine Abweichung
  const r = (roh as { cache_miss_reason?: { type?: string; cache_missed_input_tokens?: number } | null }).cache_miss_reason;
  if (r === null || r === undefined) return { ergebnis: 'ausstehend' };
  const typ = String(r.type ?? '');
  if (typ === 'previous_message_not_found') return { ergebnis: 'keine_basis' };
  if (typ === 'unavailable') return { ergebnis: 'nicht_verfuegbar' };
  const t = zahl(r.cache_missed_input_tokens);
  return { ergebnis: 'abweichung', grund: typ, ...(t !== undefined ? { verloreneToken: t } : {}) };
}

/** OpenAI Responses: `prompt_cache_diagnostics` der Antwort */
export function openaiDiagnose(roh: unknown, mitVorher: boolean): CacheDiagnose | undefined {
  if (!mitVorher) return { ergebnis: 'erster' };
  if (!roh || typeof roh !== 'object') return undefined;
  const d = roh as { type?: string; reason?: string; cache_missed_tokens?: number };
  const t = zahl(d.cache_missed_tokens);
  switch (d.type) {
    case 'cache_hit': return { ergebnis: 'treffer' };
    case 'cache_miss': return { ergebnis: 'abweichung', grund: d.reason ?? 'unbekannt', ...(t !== undefined ? { verloreneToken: t } : {}) };
    case 'comparison_response_not_found': return { ergebnis: 'keine_basis' };
    case 'unavailable': return { ergebnis: 'nicht_verfuegbar' };
    default: return undefined;
  }
}
