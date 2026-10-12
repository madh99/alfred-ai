import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { GeraetEreignis } from '@alfred/types';
import {
  STANDARD_GRENZEN, begrenzePlan, etappenAuftrag, fixAuftrag, grenzeErreicht, mutationAutomatisch, mutationText, planFrage,
  type Grenzen, type MutationsArt,
} from './satellit-projekt-regeln.js';

/**
 * v1387 (R2b/R2c, Owner-Freigabe 12.10.) — Projekt-Agent mit Ausführungsziel Satellit. Eigener schlanker Ablauf neben dem
 * unveränderten Server-Runner: Plan (Planer des Projekt-Agenten) → eine Owner-Bestätigung → je Etappe ein Claude-Code-Auftrag
 * auf dem Gerät → Ende-Meldung (R1) → Prüfbefehle (pruefen_befehl) → bei Rot Fix-Auftrag mit Prüfprotokoll (höchstens N) →
 * Umplanen (verkürzen automatisch, neuer Plantext nur nach Rückfrage) → nächste Etappe. Entscheidungen sind deterministisch;
 * die Ausgabe von Claude Code erreicht ein Modell nur im Umplan-Prüfer (mit Tor).
 *
 * Kein eigener Timer: Fortschritt kommt aus Ereignissen (Auftragsende, Owner-Antwort, Neustart). Der Stand liegt je Projekt
 * als JSON-Datei; nach einem Neustart setzt `fortsetzen()` an (Auftrag noch offen → Stand am Gerät abfragen).
 */

export interface Herkunft { chatId: string; platform: string; userId?: string }
export type ProjektStatus = 'wartet_owner' | 'laeuft' | 'fertig' | 'abgebrochen' | 'angehalten';
export interface EtappenErgebnis { nr: number; etappe: string; ok: boolean; geprueft: boolean; fixVersuche: number; kostenUsd: number; text: string }
export interface ProjektStand {
  id: string; geraetId: string; geraet: string; projekt: string; ziel: string; pruefBefehle: string[]; grenzen: Grenzen;
  herkunft?: Herkunft; ownerId?: string; vorgangId?: string;
  status: ProjektStatus; grund?: string;
  plan: string[]; nr: number; erledigt: EtappenErgebnis[]; fixVersuch: number; kostenUsd: number; etappeKostenUsd: number;
  start: number; aktualisiert: number;
  auftragId?: string;
  frage?: { nonce: string; art: 'plan' | 'weiter' | 'mutation'; mutation?: Mutation; text: string };
  letzterText?: string;
}
export interface Mutation { kind: MutationsArt; reasoning?: string; phaseIndices?: number[]; newPhase?: string; newPhases?: string[]; afterIndex?: number }
type AktionsErgebnis = { success: boolean; data?: unknown; display?: string; error?: string };

export interface SatellitProjektDeps {
  planen: (ziel: string) => Promise<string[]>;
  bewerten: (i: { goal: string; completedPhases: Array<{ index: number; description: string; modifiedFiles: string[]; resultSummary?: string }>; remainingPhases: string[]; buildPassed: boolean; buildOutput?: string }) => Promise<Mutation>;
  anwenden: (rest: string[], erledigt: number, m: Mutation) => string[];
  aktion: (geraetId: string, aktion: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<AktionsErgebnis>;
  frage: (s: ProjektStand, text: string, nonce: string) => Promise<void>;
  melde: (s: ProjektStand, text: string) => Promise<void>;
  vorgang?: { anlegen: (s: ProjektStand) => Promise<string | undefined>; schritt: (s: ProjektStand, text: string) => Promise<void>; abschliessen: (s: ProjektStand, text: string) => Promise<void> };
  ordner?: string;
  logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  now?: () => number;
}

const PRUEF_TIMEOUT_MS = 11 * 60_000;

export class SatellitProjekte {
  private readonly staende = new Map<string, ProjektStand>();
  private readonly ketten = new Map<string, Promise<void>>();

  constructor(private readonly d: SatellitProjektDeps) {
    if (d.ordner) {
      try {
        for (const f of readdirSync(d.ordner)) {
          if (!f.endsWith('.json')) continue;
          try { const s = JSON.parse(readFileSync(path.join(d.ordner, f), 'utf8')) as ProjektStand; this.staende.set(s.id, s); } catch { /* kaputt: überspringen */ }
        }
      } catch { /* Ordner fehlt */ }
    }
  }

  private jetzt(): number { return this.d.now?.() ?? Date.now(); }
  private sichere(s: ProjektStand): void {
    s.aktualisiert = this.jetzt();
    this.staende.set(s.id, s);
    if (!this.d.ordner) return;
    try { mkdirSync(this.d.ordner, { recursive: true }); const p = path.join(this.d.ordner, `${s.id}.json`); writeFileSync(`${p}.neu`, JSON.stringify(s, null, 1), { mode: 0o600 }); renameSync(`${p}.neu`, p); } catch (err) { this.d.logger.warn({ err: (err as Error).message, id: s.id }, 'v1387 Projektstand nicht gespeichert'); }
  }
  /** Schritte eines Projekts nacheinander (Ereignisse können sich überholen). */
  private seriell(id: string, f: () => Promise<void>): Promise<void> {
    const vorher = this.ketten.get(id) ?? Promise.resolve();
    const n = vorher.then(f).catch(err => this.d.logger.warn({ err: (err as Error).message, id }, 'v1387 Projektschritt fehlgeschlagen'));
    this.ketten.set(id, n);
    return n;
  }

  liste(): ProjektStand[] { return [...this.staende.values()].sort((a, b) => b.start - a.start); }
  hole(id: string): ProjektStand | undefined { return this.staende.get(id); }
  gehoertZuProjekt(auftragId: string): boolean { return [...this.staende.values()].some(s => s.auftragId === auftragId && s.status === 'laeuft'); }

  /** Start: Plan erstellen, Owner einmal fragen. Liefert die Projekt-ID sofort. */
  async starte(o: { geraetId: string; geraet: string; projekt: string; ziel: string; pruefBefehle?: string[]; grenzen?: Partial<Grenzen>; herkunft?: Herkunft; ownerId?: string }): Promise<ProjektStand> {
    const g = { ...STANDARD_GRENZEN, ...(o.grenzen ?? {}) };
    const roh = await this.d.planen(o.ziel);
    if (!roh.length) throw new Error('Der Planer lieferte keine Etappen');
    const plan = begrenzePlan(roh, g.maxEtappen);
    const s: ProjektStand = {
      id: `sat-${randomUUID().slice(0, 8)}`, geraetId: o.geraetId, geraet: o.geraet, projekt: o.projekt, ziel: o.ziel,
      pruefBefehle: [...new Set((o.pruefBefehle ?? []).map(b => b.trim()).filter(Boolean))] /* v1390 doppelte (Build = Test) nur einmal */, grenzen: g, herkunft: o.herkunft, ownerId: o.ownerId,
      status: 'wartet_owner', plan, nr: 0, erledigt: [], fixVersuch: 0, kostenUsd: 0, etappeKostenUsd: 0, start: this.jetzt(), aktualisiert: this.jetzt(),
    };
    const text = planFrage({ geraet: s.geraet, projekt: s.projekt, ziel: s.ziel, plan, pruefBefehle: s.pruefBefehle, g, gekuerzt: roh.length > plan.length });
    await this.stelleFrage(s, 'plan', text);
    try { s.vorgangId = await this.d.vorgang?.anlegen(s); } catch { /* optional */ }
    this.sichere(s);
    this.d.logger.info({ id: s.id, geraet: s.geraet, projekt: s.projekt, etappen: plan.length }, 'v1387 Satelliten-Projekt geplant');
    return s;
  }

  private async stelleFrage(s: ProjektStand, art: 'plan' | 'weiter' | 'mutation', text: string, mutation?: Mutation): Promise<void> {
    const nonce = randomUUID();
    s.frage = { nonce, art, text, ...(mutation ? { mutation } : {}) };
    if (art !== 'plan') s.status = 'wartet_owner';
    this.sichere(s);
    await this.d.frage(s, text, nonce);
  }

  /** Owner hat bestätigt (Bestätigungs-Queue ruft mit der Einmal-Kennung). Falsche oder alte Kennungen bewirken nichts. */
  antwort(id: string, nonce: string): Promise<boolean> {
    const s = this.staende.get(id);
    if (!s?.frage || s.frage.nonce !== nonce || s.status === 'fertig' || s.status === 'abgebrochen') return Promise.resolve(false);
    const f = s.frage;
    s.frage = undefined;
    return this.seriell(id, async () => {
      if (f.art === 'plan') { s.status = 'laeuft'; s.start = this.jetzt(); await this.naechsteEtappe(s); return; }
      if (f.art === 'mutation' && f.mutation) {
        const rest = s.plan.slice(s.nr);
        s.plan = [...s.plan.slice(0, s.nr), ...this.d.anwenden(rest, s.nr, f.mutation)];
        await this.d.melde(s, `Plan geändert nach deiner Bestätigung (${f.mutation.kind}); jetzt ${s.plan.length} Etappen.`);
      }
      s.status = 'laeuft';
      await this.naechsteEtappe(s);
    }).then(() => true);
  }

  stoppe(id: string, grund = 'vom Owner gestoppt'): Promise<boolean> {
    const s = this.staende.get(id);
    if (!s || s.status === 'fertig' || s.status === 'abgebrochen') return Promise.resolve(false);
    return this.seriell(id, async () => {
      if (s.auftragId) { try { await this.d.aktion(s.geraetId, 'auftrag_abbrechen', { id: s.auftragId }, 30_000); } catch { /* Gerät weg */ } }
      await this.beende(s, 'abgebrochen', grund);
    }).then(() => true);
  }

  /** Ende-Meldung eines Auftrags (R1). Gehört er zu einem laufenden Projekt, geht es dort weiter. */
  auftragEnde(e: GeraetEreignis): boolean {
    const s = [...this.staende.values()].find(x => x.auftragId === e.auftragId && x.status === 'laeuft');
    if (!s) return false;
    void this.seriell(s.id, () => this.nachAuftrag(s, e));
    return true;
  }

  /** Nach Neustart des Gehirns: offene Aufträge am Gerät abfragen; sonst kommt das Ende über das Nachreichen (R1). */
  async fortsetzen(): Promise<number> {
    let n = 0;
    for (const s of this.staende.values()) {
      if (s.status !== 'laeuft' || !s.auftragId) continue;
      n++;
      const id = s.auftragId;
      await this.seriell(s.id, async () => {
        const st = await this.d.aktion(s.geraetId, 'auftrag_stand', { id }, 30_000).catch(() => undefined);
        const daten = st?.data as { laeuft?: boolean; status?: string } | undefined;
        if (!st?.success || daten?.laeuft) return; // Gerät offline oder Auftrag läuft: Ende kommt als Ereignis
        const er = await this.d.aktion(s.geraetId, 'auftrag_ergebnis', { id }, 30_000).catch(() => undefined);
        const e = er?.data as { status?: string; text?: string; kosten?: number; dauerMs?: number; fehler?: string } | undefined;
        if (s.auftragId !== id) return;
        await this.nachAuftrag(s, { typ: 'ereignis', art: 'auftrag', auftragId: id, status: (e?.status === 'fertig' ? 'fertig' : 'fehler'), titel: '', projekt: s.projekt, text: e?.text ?? '', kosten: e?.kosten, ...(e?.fehler ? { fehler: e.fehler } : {}) } as GeraetEreignis);
      });
    }
    return n;
  }

  // ── Ablauf ──────────────────────────────────────────────────

  private async naechsteEtappe(s: ProjektStand): Promise<void> {
    if (s.nr >= s.plan.length) { await this.beende(s, 'fertig'); return; }
    s.nr += 1; s.fixVersuch = 0; s.etappeKostenUsd = 0;
    await this.starteAuftrag(s, etappenAuftrag({ ziel: s.ziel, plan: s.plan, nr: s.nr, pruefBefehle: s.pruefBefehle }), `Etappe ${s.nr}: ${s.plan[s.nr - 1]!.slice(0, 60)}`);
  }

  private async starteAuftrag(s: ProjektStand, auftrag: string, titel: string): Promise<void> {
    const grenze = grenzeErreicht({ kostenUsd: s.kostenUsd, startMs: s.start, jetztMs: this.jetzt(), g: s.grenzen });
    if (grenze) { await this.beende(s, 'angehalten', grenze); return; }
    const r = await this.d.aktion(s.geraetId, 'auftrag_starten', { projekt: s.projekt, auftrag, titel }, 60_000);
    const id = (r.data as { id?: string } | undefined)?.id;
    if (!r.success || !id) { await this.beende(s, 'angehalten', `Auftrag nicht gestartet: ${r.error ?? 'keine Kennung'}`); return; }
    s.auftragId = id;
    this.sichere(s);
    this.d.logger.info({ id: s.id, etappe: s.nr, fix: s.fixVersuch, auftrag: id }, 'v1387 Etappe gestartet');
  }

  private async nachAuftrag(s: ProjektStand, e: GeraetEreignis): Promise<void> {
    if (s.auftragId !== e.auftragId || s.status !== 'laeuft') return;
    s.auftragId = undefined;
    const kosten = e.kosten ?? 0;
    s.kostenUsd += kosten; s.etappeKostenUsd += kosten;
    s.letzterText = (e.text ?? '').slice(-400);
    this.sichere(s);
    const etappe = s.plan[s.nr - 1]!;
    if (e.status === 'abgebrochen') { await this.beende(s, 'abgebrochen', 'Auftrag am Gerät abgebrochen'); return; }

    if (!s.pruefBefehle.length) {
      // ohne Abnahme keine automatische nächste Etappe (Owner-Entscheidung 12.10.)
      this.vermerke(s, { ok: e.status === 'fertig', geprueft: false });
      await this.stelleFrage(s, 'weiter', `Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" ${e.status === 'fertig' ? 'fertig' : 'mit Fehler beendet'} (ungeprüft, ${s.etappeKostenUsd.toFixed(2)} USD). Mit der nächsten Etappe weitermachen?`);
      return;
    }
    const p = await this.d.aktion(s.geraetId, 'pruefen_befehl', { pruefungen: s.pruefBefehle.map(b => ({ art: 'befehl', ziel: b, cwd: s.projekt, timeoutS: 600 })) }, PRUEF_TIMEOUT_MS);
    const ok = p.success && (p.data as { ok?: boolean } | undefined)?.ok === true;
    const protokoll = p.display ?? p.error ?? 'keine Ausgabe';
    if (ok) {
      this.vermerke(s, { ok: true, geprueft: true });
      await this.d.melde(s, `✅ Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" abgenommen${s.fixVersuch ? ` nach ${s.fixVersuch} Fix-Versuch(en)` : ''} · ${s.etappeKostenUsd.toFixed(2)} USD, gesamt ${s.kostenUsd.toFixed(2)} USD.`);
      await this.d.vorgang?.schritt(s, `Etappe ${s.nr} abgenommen: ${etappe.slice(0, 160)}`).catch(() => undefined);
      await this.umplanen(s, true, protokoll);
      return;
    }
    if (s.fixVersuch < s.grenzen.maxFixVersuche) {
      s.fixVersuch += 1;
      await this.d.melde(s, `🔧 Etappe ${s.nr}: Abnahme rot — Fix-Versuch ${s.fixVersuch}/${s.grenzen.maxFixVersuche}.`);
      await this.starteAuftrag(s, fixAuftrag({ ziel: s.ziel, nr: s.nr, etappe, versuch: s.fixVersuch, pruefprotokoll: protokoll }), `Etappe ${s.nr}: Fix ${s.fixVersuch}`);
      return;
    }
    this.vermerke(s, { ok: false, geprueft: true });
    await this.stelleFrage(s, 'weiter', `❌ Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" nach ${s.grenzen.maxFixVersuche} Fix-Versuchen weiter rot:\n${protokoll.slice(0, 800)}\nTrotzdem mit der nächsten Etappe weitermachen? (Sonst: stoppen)`);
  }

  private vermerke(s: ProjektStand, o: { ok: boolean; geprueft: boolean }): void {
    s.erledigt = [...s.erledigt.filter(x => x.nr !== s.nr), { nr: s.nr, etappe: s.plan[s.nr - 1]!, ok: o.ok, geprueft: o.geprueft, fixVersuche: s.fixVersuch, kostenUsd: s.etappeKostenUsd, text: s.letzterText ?? '' }];
    this.sichere(s);
  }

  private async umplanen(s: ProjektStand, buildOk: boolean, protokoll: string): Promise<void> {
    const rest = s.plan.slice(s.nr);
    if (!rest.length) { await this.beende(s, 'fertig'); return; }
    let m: Mutation = { kind: 'proceed' };
    try {
      m = await this.d.bewerten({
        goal: s.ziel,
        completedPhases: s.erledigt.map(x => ({ index: x.nr - 1, description: x.etappe, modifiedFiles: [], resultSummary: x.text })),
        remainingPhases: rest, buildPassed: buildOk, buildOutput: protokoll.slice(0, 1500),
      });
    } catch { m = { kind: 'proceed' }; }
    if (m.kind === 'proceed') { await this.naechsteEtappe(s); return; }
    if (mutationAutomatisch(m.kind)) {
      s.plan = [...s.plan.slice(0, s.nr), ...this.d.anwenden(rest, s.nr, m)];
      this.d.logger.info({ id: s.id, art: m.kind, etappen: s.plan.length }, 'v1387 Plan verkürzt');
      await this.d.melde(s, `Plan verkürzt (${m.kind}): ${String(m.reasoning ?? '').slice(0, 200)} — jetzt ${s.plan.length} Etappen.`);
      await this.naechsteEtappe(s);
      return;
    }
    // neuer Plantext: nur nach Rückfrage
    this.d.logger.info({ id: s.id, art: m.kind }, 'v1387 Planänderung zur Rückfrage');
    await this.stelleFrage(s, 'mutation', `${mutationText(m, rest)}\nÜbernehmen? (Sonst geht es mit dem bisherigen Plan weiter: Projekt stoppen oder mit „weiter ohne Änderung" fortsetzen)`, m);
  }

  /** Owner will ohne die vorgeschlagene Änderung weiter (Rückfrage „mutation" abgelehnt). */
  weiterOhneAenderung(id: string): Promise<boolean> {
    const s = this.staende.get(id);
    if (!s?.frage || s.frage.art !== 'mutation') return Promise.resolve(false);
    s.frage = undefined;
    return this.seriell(id, async () => { s.status = 'laeuft'; await this.naechsteEtappe(s); }).then(() => true);
  }

  private async beende(s: ProjektStand, status: 'fertig' | 'abgebrochen' | 'angehalten', grund?: string): Promise<void> {
    s.status = status; s.grund = grund; s.auftragId = undefined; s.frage = undefined;
    this.sichere(s);
    const ok = s.erledigt.filter(x => x.ok).length;
    const text = `${status === 'fertig' ? '🏁 Projekt fertig' : status === 'angehalten' ? '⏸ Projekt angehalten' : '⏹ Projekt abgebrochen'}: „${s.ziel.slice(0, 120)}" auf ${s.geraet}${grund ? ` — ${grund}` : ''}. ${ok}/${s.plan.length} Etappen ok, ${s.kostenUsd.toFixed(2)} USD, ${Math.round((this.jetzt() - s.start) / 60_000)} min. Verzeichnis: ${s.projekt}`;
    this.d.logger.info({ id: s.id, status, grund, etappenOk: ok, etappen: s.plan.length, kostenUsd: s.kostenUsd }, 'v1387 Satelliten-Projekt beendet');
    await this.d.melde(s, text);
    await this.d.vorgang?.abschliessen(s, text).catch(() => undefined);
  }
}
