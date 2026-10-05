import type { Logger } from 'pino';
import { istNachtjobFaellig, lokalesDatum } from '../nachtjob-plan.js';

/**
 * Jarvis Schicht 0 — Lebenszeichen: das Job-Register.
 *
 * Statt verstreuter `setInterval`-Blöcke in alfred.ts werden periodische Jobs
 * DEKLARIERT: Schlüssel, Takt, Geltungsbereich, Slot-Dedup, Lauf-Funktion.
 * Das Register plant alle auf dem 10-Minuten-Raster (Lektion v1158: nie
 * Stunden-Timer mit Minuten-Fenster), holt tägliche/wöchentliche Jobs nach
 * einem Restart einmalig nach, schreibt jeden Lauf nach `job_runs` und loggt
 * einheitlich „registriert" / „gelaufen" / „fehlgeschlagen" — damit ein toter
 * Job nie wieder 16 Tage unbemerkt bleibt (Lektion v1154/v1158).
 */

export type JobTakt =
  | { art: 'taeglich'; um: string }                 // 'HH:MM' lokal
  | { art: 'woechentlich'; tag: number; um: string } // tag: 0=So … 6=Sa
  | { art: 'intervall'; minuten: number };

/** Für wen läuft der Job: je Master-User, je Benutzerzeile, oder einmal ohne User. */
export type JobBereich = 'master' | 'alle' | 'global';

export interface JobErgebnis {
  ok: boolean;
  zaehler?: Record<string, number>;
  fehler?: string;
}

export interface JobDefinition {
  key: string;
  beschreibung: string;
  takt: JobTakt;
  bereich: JobBereich;
  /** HA-Dedup über reasoning_slots (`<key>:<tag>`); für intervall-Jobs ignoriert. */
  slot?: boolean;
  /** Nur intervall: erster Lauf frühestens so viele Minuten nach der Registrierung (Boot nicht belasten). */
  startVerzoegerungMin?: number;
  /** Zeitbudget je Lauf (Standard 10 min). Überschreitung wird als Fehler protokolliert; der Lauf blockiert andere Jobs nicht. */
  timeoutMin?: number;
  run: (ctx: { userId: string | null }) => Promise<JobErgebnis | void>;
}

export interface JobRegisterDeps {
  logger: Logger;
  nodeId: string;
  listMasters: () => Promise<Array<{ id: string }>>;
  listAll: () => Promise<Array<{ id: string }>>;
  claimSlot: (slotKey: string) => Promise<boolean>;
  runs?: {
    start(jobKey: string, userId: string | null, nodeId: string): Promise<string>;
    finish(id: string, ok: boolean, zaehler?: Record<string, number>, fehler?: string): Promise<void>;
  };
  now?: () => Date;
}

interface JobZustand {
  zuletztTag: string;      // für taeglich/woechentlich
  zuletztMs?: number;      // für intervall
  laeuft: boolean;
}

export const RASTER_MS = 10 * 60_000;
export const INTERVALL_TOLERANZ_MS = 30_000;
export const STANDARD_TIMEOUT_MIN = 10;

/** Reine Fälligkeitsregel — testbar ohne Timer. Liefert den Tages-Marker oder null. */
export function istJobFaellig(takt: JobTakt, now: Date, zustand: Pick<JobZustand, 'zuletztTag' | 'zuletztMs'>): string | null {
  if (takt.art === 'intervall') {
    // v1166 — Toleranz von 30 s: ein 10-min-Job auf dem 10-min-Raster darf durch
    // Timer-Jitter nicht jeden zweiten Tick verpassen.
    const faellig = zustand.zuletztMs === undefined || now.getTime() - zustand.zuletztMs >= takt.minuten * 60_000 - INTERVALL_TOLERANZ_MS;
    return faellig ? lokalesDatum(now) : null;
  }
  if (takt.art === 'woechentlich' && now.getDay() !== takt.tag) return null;
  const [h, m] = takt.um.split(':').map(Number);
  return istNachtjobFaellig(now, h, m, zustand.zuletztTag);
}

export class JobRegister {
  private readonly jobs = new Map<string, { def: JobDefinition; zustand: JobZustand }>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: JobRegisterDeps) {}

  registriere(def: JobDefinition): void {
    if (this.jobs.has(def.key)) throw new Error(`Job doppelt registriert: ${def.key}`);
    const zustand: JobZustand = { zuletztTag: '', laeuft: false };
    if (def.takt.art === 'intervall') {
      if (def.takt.minuten * 60_000 < RASTER_MS) {
        this.deps.logger.warn({ job: def.key, minuten: def.takt.minuten }, 'Lebenszeichen: Intervall unter dem 10-min-Raster — Job läuft alle 10 min');
      }
      if (def.startVerzoegerungMin) {
        // So setzen, dass der erste Lauf frühestens nach der Verzögerung fällig wird
        const jetzt = (this.deps.now ?? (() => new Date()))().getTime();
        zustand.zuletztMs = jetzt + def.startVerzoegerungMin * 60_000 - def.takt.minuten * 60_000;
      }
    }
    this.jobs.set(def.key, { def, zustand });
    this.deps.logger.info({ job: def.key, takt: def.takt, bereich: def.bereich, ...(def.startVerzoegerungMin ? { startVerzoegerungMin: def.startVerzoegerungMin } : {}) }, 'Lebenszeichen: Job registriert');
  }

  keys(): string[] { return [...this.jobs.keys()]; }

  /** Für Proben und Kachel: die Deklarationen ohne Lauf-Funktion. */
  definitionen(): Array<Pick<JobDefinition, 'key' | 'beschreibung' | 'takt' | 'bereich' | 'slot'>> {
    return [...this.jobs.values()].map(({ def }) => ({ key: def.key, beschreibung: def.beschreibung, takt: def.takt, bereich: def.bereich, slot: def.slot }));
  }

  /** Zeitpunkt von start() — ein Job ohne Lauf ist erst nach einem Takt ab hier auffällig. */
  gestartetAm?: string;

  /** 10-Minuten-Raster starten; erster Tick sofort (Nachholen nach Restart). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, RASTER_MS);
    (this.timer as { unref?: () => void }).unref?.();
    this.gestartetAm = (this.deps.now ?? (() => new Date()))().toISOString();
    this.deps.logger.info({ jobs: this.keys() }, 'Lebenszeichen: Job-Register gestartet (10-min-Raster)');
    void this.tick();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /**
   * Ein Raster-Tick: alle fälligen Jobs ausführen. Öffentlich für Tests.
   * v1173 — Jobs laufen PARALLEL mit Zeitbudget (Realfall 05.10.: cmdb-discovery
   * 50 s verschob den Sammler; ein hängender Job hätte alle blockiert). Ein
   * Job, der sein Budget überschreitet, gilt als fehlgeschlagen, bleibt aber
   * als „läuft" markiert, bis er wirklich endet — kein Doppelstart.
   */
  async tick(now: Date = (this.deps.now ?? (() => new Date()))()): Promise<void> {
    const faellig: Array<{ def: JobDefinition; zustand: JobZustand }> = [];
    for (const eintrag of this.jobs.values()) {
      const { def, zustand } = eintrag;
      if (zustand.laeuft) continue;
      const marker = istJobFaellig(def.takt, now, zustand);
      if (!marker) continue;
      zustand.zuletztTag = marker;
      zustand.zuletztMs = now.getTime();
      if (def.slot && def.takt.art !== 'intervall') {
        const frei = await this.deps.claimSlot(`${def.key}:${marker}`);
        if (!frei) { this.deps.logger.debug({ job: def.key, marker }, 'Lebenszeichen: Slot von anderem Node — übersprungen'); continue; }
      }
      zustand.laeuft = true;
      faellig.push(eintrag);
    }
    await Promise.all(faellig.map(({ def, zustand }) => this.mitZeitbudget(def, zustand)));
  }

  private async mitZeitbudget(def: JobDefinition, zustand: JobZustand): Promise<void> {
    const budgetMs = (def.timeoutMin ?? STANDARD_TIMEOUT_MIN) * 60_000;
    const lauf = this.ausfuehren(def).catch(err => {
      this.deps.logger.warn({ job: def.key, err: (err as Error).message }, 'Lebenszeichen: Job fehlgeschlagen (unerwartet)');
    }).finally(() => { zustand.laeuft = false; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs); (timer as { unref?: () => void }).unref?.(); });
    const ergebnis = await Promise.race([lauf.then(() => 'fertig' as const), budget]);
    if (timer) clearTimeout(timer);
    if (ergebnis === 'timeout') {
      this.deps.logger.warn({ job: def.key, budgetMin: def.timeoutMin ?? STANDARD_TIMEOUT_MIN }, 'Lebenszeichen: Job fehlgeschlagen (Zeitbudget überschritten — läuft im Hintergrund weiter, kein Doppelstart)');
      void lauf.then(() => this.deps.logger.info({ job: def.key }, 'Lebenszeichen: Job nachträglich beendet'));
    }
  }

  private async ausfuehren(def: JobDefinition): Promise<void> {
    const start = Date.now();
    let userIds: Array<string | null>;
    try {
      userIds = def.bereich === 'global' ? [null]
        : def.bereich === 'master' ? (await this.deps.listMasters()).map(u => u.id)
        : (await this.deps.listAll()).map(u => u.id);
    } catch (err) {
      this.deps.logger.warn({ job: def.key, err: (err as Error).message }, 'Lebenszeichen: Job fehlgeschlagen (User-Liste)');
      return;
    }
    let okZahl = 0; const fehler: string[] = []; const summe: Record<string, number> = {};
    for (const userId of userIds) {
      let runId: string | undefined;
      try { runId = await this.deps.runs?.start(def.key, userId, this.deps.nodeId); } catch { /* Persistenz ist Zusatz */ }
      try {
        const r = (await def.run({ userId })) ?? { ok: true };
        if (r.ok) okZahl++; else fehler.push(r.fehler ?? 'unbekannt');
        for (const [k, v] of Object.entries(r.zaehler ?? {})) summe[k] = (summe[k] ?? 0) + v;
        if (runId) await this.deps.runs?.finish(runId, r.ok, r.zaehler, r.fehler).catch(() => undefined);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        fehler.push(msg);
        if (runId) await this.deps.runs?.finish(runId, false, undefined, msg).catch(() => undefined);
      }
    }
    const dauerMs = Date.now() - start;
    if (fehler.length === 0) {
      this.deps.logger.info({ job: def.key, users: userIds.length, dauerMs, ...summe }, 'Lebenszeichen: Job gelaufen');
    } else {
      this.deps.logger.warn({ job: def.key, users: userIds.length, ok: okZahl, fehler: fehler.slice(0, 3), dauerMs, ...summe }, 'Lebenszeichen: Job fehlgeschlagen');
    }
  }
}
