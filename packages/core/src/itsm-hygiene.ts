/**
 * v1153 — ITSM-Hygiene: Lebenszyklus für Incidents, die kein Monitor heilt.
 *
 * Befund 30.08.: 31 offene Incidents, alle 120+ Tage alt — 25 davon detected_by
 * 'user_report' (LLM-/Chat-angelegt), für die es KEINEN Lifecycle gab: kein
 * Auto-Resolve, keine Stale-Regel, keine Rückfrage. Sie fütterten als
 * Dauerrauschen jeden Reasoning-Pass („5 kritische ITSM-Incidents —
 * Priorisierung nötig!") — derselbe Spam-Mechanismus wie beim MQTT-Fall.
 *
 * Drei deterministische Bausteine:
 * - C (Korrektur-Kopplung): Widerlegt eine Unterdrückungs-Korrektur den
 *   Incident-Inhalt, wird er resolved (gilt für ALLE detected_by).
 * - B (Stale-Lifecycle): Nicht-Monitor-Incidents ohne Update seit ≥21 Tagen
 *   bekommen EINE Rückfrage (Marker in investigation_notes); bleibt sie
 *   14 Tage unbeantwortet, wird auto-resolved.
 * - D (Problem-Eskalation): Offene Problems ≥14 Tage werden sonntags gebündelt
 *   zur Entscheidung vorgelegt statt ewig still 'logged' zu bleiben.
 */
import { findeVerletzteUnterdrueckungsKorrektur, type UnterdrueckungsTreffer } from './reasoning-engine.js';

export const STALE_ANFRAGE_MARKER = '[stale-anfrage ';

export interface HygieneIncident {
  id: string;
  title: string;
  description?: string;
  status: string;
  detectedBy?: string;
  updatedAt: string;
  investigationNotes?: string;
}

/** C — Incident ist durch eine User-Korrektur („ist normal / nicht melden") widerlegt. */
export function istDurchKorrekturWiderlegt(
  inc: { title: string; description?: string },
  korrekturen: Array<{ key: string; value: string }>,
): UnterdrueckungsTreffer | null {
  return findeVerletzteUnterdrueckungsKorrektur(`${inc.title}\n${inc.description ?? ''}`, korrekturen);
}

/** Datum der bereits gestellten Stale-Rückfrage aus investigation_notes, sonst null. */
export function staleAnfrageDatum(investigationNotes: string | undefined): string | null {
  const m = (investigationNotes ?? '').match(/\[stale-anfrage (\d{4}-\d{2}-\d{2})\]/);
  return m ? m[1] : null;
}

/**
 * B — Stale-Urteil: 'fragen' (einmalige Rückfrage fällig), 'resolven'
 * (Rückfrage-Frist abgelaufen) oder null. Monitor-Incidents sind ausgenommen —
 * die heilt das bestehende Auto-Recovery.
 */
export function bewerteStaleKandidat(
  inc: HygieneIncident,
  jetztMs: number,
  schwellen: { askTage: number; resolveTage: number } = { askTage: 21, resolveTage: 14 },
): 'fragen' | 'resolven' | null {
  if (inc.status === 'resolved' || inc.status === 'closed') return null;
  if (inc.detectedBy === 'monitor') return null;
  const gefragt = staleAnfrageDatum(inc.investigationNotes);
  if (gefragt) {
    const tageSeitAnfrage = (jetztMs - Date.parse(gefragt)) / 86_400_000;
    return tageSeitAnfrage >= schwellen.resolveTage ? 'resolven' : null;
  }
  const tageStill = (jetztMs - Date.parse(inc.updatedAt)) / 86_400_000;
  if (!Number.isFinite(tageStill)) return null;
  return tageStill >= schwellen.askTage ? 'fragen' : null;
}
