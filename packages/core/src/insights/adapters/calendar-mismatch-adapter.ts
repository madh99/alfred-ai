import type { DomainAdapter, AdapterContext } from '../insight-engine.js';
import type { InsightCandidate } from '@alfred/storage';
import type { CalendarFacade } from './cross-source-mention-adapter.js';

export interface BmwFacade {
  /** Latest known status snapshot from the BMW telematic log. */
  latestStatus(userId: string): Promise<{ rangeKm?: number; soc?: number; mileage?: number; updatedAt?: string } | null>;
}

/**
 * v638 — Calendar × BMW: Termin mit Location existiert in den nächsten 24h, BMW-Range
 * deutlich kleiner als plausible Fahrt-Distanz. Heuristik (ohne Routing):
 *  - Range < 50km bei Termin mit Location-String länger als 5 Zeichen → "vorher laden"
 *  - Bei Range ≥ 50km gehen wir davon aus dass innerstädtisches reicht.
 *
 * Erweiterung via Routing-Skill möglich (echte Distance-Lookup), bewusst nicht hier um
 * den Adapter klein zu halten.
 */
export class CalendarMismatchAdapter implements DomainAdapter {
  readonly name = 'calendar-mismatch';

  constructor(
    private readonly calendar: CalendarFacade,
    private readonly bmw?: BmwFacade,
  ) {}

  async generate(ctx: AdapterContext): Promise<InsightCandidate[]> {
    const out: InsightCandidate[] = [];
    let events: Awaited<ReturnType<typeof this.calendar.listUpcoming>> = [];
    try { events = await this.calendar.listUpcoming(ctx.userId, 1); } catch { return out; }

    if (!this.bmw) {
      // Ohne BMW können wir nur "Termin mit Location ohne Reise-Buffer" detektieren — back-to-back-Logik
      // brauchen wir hier nicht (Calendar-Skill kann das schon). Lass es.
      return out;
    }

    let status: Awaited<ReturnType<BmwFacade['latestStatus']>> = null;
    try { status = await this.bmw.latestStatus(ctx.userId); } catch { return out; }
    if (!status || typeof status.rangeKm !== 'number') return out;

    const rangeKm = status.rangeKm;
    const soc = status.soc ?? null;
    const ageHours = status.updatedAt ? Math.round((Date.now() - new Date(status.updatedAt).getTime()) / 3_600_000) : null;

    for (const ev of events) {
      if (!ev.location || ev.location.length < 5) continue;
      // Termin innerhalb 24h?
      const startMs = new Date(ev.startAt).getTime();
      const hoursUntil = (startMs - Date.now()) / 3_600_000;
      if (hoursUntil < 0 || hoursUntil > 24) continue;

      const tight = rangeKm < 50;
      const veryTight = rangeKm < 25;
      if (!tight) continue;

      const urgency = veryTight ? '🔴 Range knapp' : '🟡 Range eng';
      out.push({
        category: 'calendar-mismatch',
        title: `${urgency} für Termin "${ev.title.slice(0, 40)}" in ${ev.location.slice(0, 30)}`,
        body: `**Termin**: ${new Date(ev.startAt).toLocaleString('de-AT')} — ${ev.title}\n**Location**: ${ev.location}\n**BMW-Range**: ${rangeKm}km${soc != null ? ` (${soc}% SOC)` : ''}${ageHours != null ? `, Status vor ${ageHours}h aktualisiert` : ''}\n\nDie Range könnte für die Fahrt knapp werden. Heute Abend mit der Wallbox auflanden (idealerweise im Strompreis-Tief 22-04h) erspart Spannungs-Stress am Morgen.`,
        confidence: veryTight ? 0.85 : 0.7,
        sourceData: { eventId: ev.id, eventStart: ev.startAt, rangeKm, soc, location: ev.location },
        actionSkill: 'goecharger',
        actionParams: { action: 'set_charging_window', /* user passt Details an */ },
        dedupeKey: `cal-bmw:${ev.id}`,
      });
    }
    return out;
  }
}
