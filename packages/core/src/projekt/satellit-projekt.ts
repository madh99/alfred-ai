import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { GeraetEreignis } from '@alfred/types';
import { konventionsBlock, changelogPflicht, changelogAuftrag, type Konventionen } from './konventionen.js'; // v1426
import { START_REGEL } from './geraet-dev.js'; // v1460
import {
  STANDARD_GRENZEN, begrenzePlan, etappenAuftrag, etappenBerichtText, fixAuftrag, grenzeErreicht, mutationAutomatisch, mutationText, planFrage, projektZeile, uhrzeit, fehlendeWerkzeuge, installVorschlag, pfadeSicher,
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
export interface EtappenErgebnis {
  nr: number; etappe: string; ok: boolean; geprueft: boolean; fixVersuche: number; kostenUsd: number; text: string;
  /** v1417 G1 — Etappenbericht: vollständige Zusammenfassung von Claude Code, geänderte Dateien, Commit, Abnahme, Dauer */
  zusammenfassung?: string; dateien?: string[]; dateienAnzahl?: number; commit?: { sha: string; titel: string }; abnahme?: { ok: boolean; protokoll: string }; dauerS?: number;
  /** v1484 F1 — ohne Prüfbefehle: der Owner hat die Etappe mit seinem Ja abgenommen (bleibt ungeprüft) */
  ownerAbgenommen?: boolean;
}
export interface ProjektStand {
  id: string; geraetId: string; geraet: string; projekt: string; ziel: string; pruefBefehle: string[]; grenzen: Grenzen;
  herkunft?: Herkunft; ownerId?: string; vorgangId?: string;
  status: ProjektStatus; grund?: string;
  plan: string[]; nr: number; erledigt: EtappenErgebnis[]; fixVersuch: number; kostenUsd: number; etappeKostenUsd: number;
  /** v1426 — Etappe, in der CHANGELOG.md geändert wurde bzw. für die der Nachtrag schon lief (kein zweiter) */
  changelogOk?: number; changelogNachgetragen?: number;
  start: number; aktualisiert: number;
  auftragId?: string;
  /** v1394 — Grenzen im neuen Format (Budget/Zeit nur vom Owner) */
  grenzenStand?: number;
  /** v1392 — Start des laufenden Auftrags (Lage, Vorgang) */
  etappeStart?: number;
  /** v1397 — bestehendes Verzeichnis ohne Git: beim ersten Auftrag Repository + Ausgangs-Commit (mit dem Plan freigegeben) */
  gitUebernehmen?: boolean;
  /** v1398 — Projektakte (Gerät + Pfad); Name schon bei der Planfrage, Kennung spätestens nach der Freigabe */
  akteId?: string;
  akteName?: string;
  /** v1398 — Weiterarbeit an einem bestehenden Projekt (Etappen-Auftrag erweitert statt neu) */
  bestehend?: boolean;
  /** v1408 R3a — Umgebung des Geräts (eine Zeile) für Planfrage und Etappen-Auftrag */
  umgebung?: string;
  /** v1409 R3b — sudo in den Aufträgen gesperrt (Projekt-Option); die Geräte-Einstellung wirkt am Satelliten selbst */
  sudoSperre?: boolean;
  /** v1453 — beim Start vorgefundene, nicht eingecheckte Änderungen (gehören dem Owner) */
  vorgefunden?: string[];
  /** v1455 — Merge-Request-Modus dieses Laufs: Zweig, Ziel, MR, gelesene Kommentare; `aus` = für diesen Lauf nicht möglich (Grund) */
  mr?: { zweig: string; ziel?: string; iid?: number; url?: string; kommentarBis?: number; zusammengefuehrt?: boolean; aus?: string; /** v1458 — Lauf setzt den offenen MR früherer Läufe fort */ fortsetzungVon?: string[]; /** v1458 — Zusammenführen wartet auf das Ja des Owners */ wartetAufJa?: boolean };
  frage?: { nonce: string; art: FrageArt; mutation?: Mutation; text: string; /** v1410 R3c */ installation?: { werkzeug: string; quelle: string; paket: string }; /** v1484 F1 — „Weiter?“ nach fertiger Etappe ohne Prüfbefehle: Ja = Abnahme durch den Owner */ ownerAbnahme?: boolean; /** v1485 F2 — vorgeschlagene Prüfbefehle (Ja = übernehmen) */ pruefVorschlag?: string[] };
  /** v1485 F2 — Vorschlag für Prüfbefehle in diesem Lauf abgelehnt (nicht noch einmal fragen) */
  pruefVorschlagAus?: boolean;
  /** v1410 R3c — Werkzeuge, nach deren Installation schon gefragt wurde (keine Schleife); letztes Prüfprotokoll für den Fix-Versuch ohne Installation */
  installiertGefragt?: string[];
  letztesProtokoll?: string;
  /** v1417 G1 — gesammelt über alle Aufträge der laufenden Etappe (inkl. Fix-Versuche) */
  etappeLauf?: { text: string; dateien: string[]; dateienAnzahl: number; dauerS: number };
  /** v1415 — Etappe konnte nicht starten, weil das Gerät kurz weg war (Update, Neustart): startet, sobald es wieder verbunden ist */
  wartetAufGeraet?: { auftrag: string; titel: string; seit: number };
  letzterText?: string;
}
/** v1398 — Kontext für den Planer bei Weiterarbeit: frühere Läufe, letzte Commits, Bestand (als Daten). */
export interface PlanKontext { vorherige?: Array<{ goal: string; milestones: string[] }>; commits?: Array<{ sha: string; message: string; files: string[] }>; bestand?: string }

export type FrageArt = 'plan' | 'weiter' | 'mutation' | 'installieren' | 'pruefung';

export interface Mutation { kind: MutationsArt; reasoning?: string; phaseIndices?: number[]; newPhase?: string; newPhases?: string[]; afterIndex?: number }
type AktionsErgebnis = { success: boolean; data?: unknown; display?: string; error?: string };

export interface SatellitProjektDeps {
  planen: (ziel: string, kontext?: PlanKontext) => Promise<string[]>;
  /** v1398 — Projektakte: nach der Plan-Freigabe zuordnen bzw. anlegen; nach dem Ende berühren (letzte Aktivität) */
  akte?: { zuordnen: (s: ProjektStand) => Promise<string | undefined>; beruehren?: (s: ProjektStand) => Promise<void> };
  bewerten: (i: { goal: string; completedPhases: Array<{ index: number; description: string; modifiedFiles: string[]; resultSummary?: string }>; remainingPhases: string[]; buildPassed: boolean; buildOutput?: string }) => Promise<Mutation>;
  anwenden: (rest: string[], erledigt: number, m: Mutation) => string[];
  aktion: (geraetId: string, aktion: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<AktionsErgebnis>;
  frage: (s: ProjektStand, text: string, nonce: string) => Promise<void>;
  /** v1419 G3 — art: 'ende' (Projekt beendet → auch ins Hauptgespräch), 'frage' (Rückfrage, nur Projektfaden), sonst Etappenmeldung */
  melde: (s: ProjektStand, text: string, art?: 'etappe' | 'ende' | 'frage') => Promise<void>;
  vorgang?: { anlegen: (s: ProjektStand) => Promise<string | undefined>; schritt: (s: ProjektStand, text: string) => Promise<void>; abschliessen: (s: ProjektStand, text: string) => Promise<void>; /** v1392 — „nächster Schritt" nachführen */ stand?: (s: ProjektStand, text: string, wartet: boolean) => Promise<void> };
  /** v1425 — Protokoll im Projekt an (Auftrag + Bericht je Etappe mit committen) oder aus (nur lokal); Schalter je Projekt, Standard an */
  protokollAn?: (s: ProjektStand) => Promise<boolean>;
  /** v1426 — Konventionen des Projekts (README/CHANGELOG/Commits/eigene Regeln), Schalter je Projekt in App und Web */
  konventionen?: (s: ProjektStand) => Promise<Konventionen | undefined>;
  /** v1434 B13 — nach einer abgenommenen Etappe (z. B. Push zu GitLab); liefert eine Zeile für die Etappenmeldung oder nichts */
  nachAbnahme?: (s: ProjektStand, o?: { ohneDev?: boolean }) => Promise<string | undefined>;
  /** v1485 F2 — Prüfbefehle aus dem Projekt am Gerät vorschlagen (Satellit ≥ 1485, sonst undefined) */
  pruefVorschlag?: (s: ProjektStand) => Promise<{ befehle: string[]; quelle?: string } | undefined>;
  /** v1485 F2 — übernommene Prüfbefehle in die Projektakte (gelten für spätere Läufe) */
  pruefBefehleSetzen?: (s: ProjektStand, befehle: string[]) => Promise<void>;
  /** v1437 B14 — nach dem Ende eines Laufs (z. B. automatisch in dev deployen, wenn alle Etappen grün abgenommen sind) */
  nachLauf?: (s: ProjektStand) => Promise<void>;
  /** v1455 — vor jedem Auftrag (Merge-Request-Modus: Zweig anlegen, neue MR-Kommentare des Owners als Hinweise); Meldung geht in den Faden */
  vorEtappe?: (s: ProjektStand) => Promise<{ hinweise?: string; meldung?: string } | undefined>;
  /** v1460 — dev am Gerät für ein übernommenes Projekt eingeschaltet → Startregel in den Auftrag (neue Projekte bekommen sie immer) */
  devAktiv?: (s: ProjektStand) => Promise<boolean>;
  /** v1460 — Etappe ohne Abnahme (Owner prüft selbst): dev am Gerät trotzdem neu starten; liefert eine Meldezeile */
  devNachEtappe?: (s: ProjektStand) => Promise<string | undefined>;
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
          try {
            const s = JSON.parse(readFileSync(path.join(d.ordner, f), 'utf8')) as ProjektStand;
            // v1394 — alte Stände: automatisch gesetzte 5 USD/4 h entfallen (nur vom Owner genannte Grenzen gelten)
            if (!s.grenzenStand) { if (s.grenzen.budgetUsd === 5) delete s.grenzen.budgetUsd; if (s.grenzen.maxStunden === 4) delete s.grenzen.maxStunden; s.grenzenStand = 1394; }
            this.staende.set(s.id, s);
          } catch { /* kaputt: überspringen */ }
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
  /** v1392 — Lage: laufende und wartende Projekte in einer Zeile (null, wenn keine). */
  lageZeile(): string | null {
    const z = this.liste().map(s => projektZeile(s, this.jetzt())).filter((x): x is string => !!x);
    return z.length ? `Projekte auf Geräten: ${z.slice(0, 3).join(' · ')}${z.length > 3 ? ` · +${z.length - 3}` : ''}` : null;
  }

  /**
   * v1415 — wartende Etappen starten (Gerät wieder verbunden bzw. Rückfall-Job). Nach 24 h ohne Gerät: angehalten.
   * `geraetId` = nur Läufe dieses Geräts. Liefert die Zahl der Startversuche.
   */
  async nachholen(geraetId?: string): Promise<number> {
    let n = 0;
    for (const s of this.staende.values()) {
      const w = s.wartetAufGeraet;
      if (s.status !== 'laeuft' || !w || (geraetId && s.geraetId !== geraetId)) continue;
      n++;
      await this.seriell(s.id, async () => {
        if (s.status !== 'laeuft' || !s.wartetAufGeraet) return;
        if (this.jetzt() - s.wartetAufGeraet.seit > 24 * 3_600_000) { s.wartetAufGeraet = undefined; await this.beende(s, 'angehalten', `${s.geraet} 24 h nicht erreichbar`); return; }
        await this.starteAuftrag(s, w.auftrag, w.titel);
      });
    }
    return n;
  }

  /** v1398 — Läufe einer Akte (neueste zuerst) und Läufe ohne Akte (Migration beim Start). */
  laeufeDerAkte(akteId: string): ProjektStand[] { return this.liste().filter(s => s.akteId === akteId); }
  ohneAkte(): ProjektStand[] { return this.liste().filter(s => !s.akteId && s.status !== 'wartet_owner'); }
  setzeAkte(id: string, akteId: string, akteName?: string): void { const s = this.staende.get(id); if (!s) return; s.akteId = akteId; if (akteName) s.akteName = akteName; this.sichere(s); }

  /** v1457 — Läufe eines endgültig gelöschten Projekts entfernen (Speicher und Dateien); nur beendete — sonst 0 und nichts. */
  entferneLaeufe(akteId: string): number {
    const l = this.laeufeDerAkte(akteId);
    if (l.some(x => x.status === 'laeuft' || x.status === 'wartet_owner')) return 0;
    for (const x of l) { this.staende.delete(x.id); if (this.d.ordner) { try { rmSync(path.join(this.d.ordner, `${x.id}.json`), { force: true }); } catch { /* bleibt */ } } }
    return l.length;
  }

  /** v1455 — Laufstand nach einer Änderung von außen (z. B. Merge Request zusammengeführt) speichern. */
  merke(s: ProjektStand): void { if (this.staende.get(s.id) === s) this.sichere(s); }

  gehoertZuProjekt(auftragId: string): boolean { return [...this.staende.values()].some(s => s.auftragId === auftragId && s.status === 'laeuft'); }

  /** Start: Plan erstellen, Owner einmal fragen. Liefert die Projekt-ID sofort. */
  async starte(o: { geraetId: string; geraet: string; projekt: string; ziel: string; pruefBefehle?: string[]; grenzen?: Partial<Grenzen>; herkunft?: Herkunft; ownerId?: string; verzeichnisNeu?: boolean; gitUebernehmen?: boolean; akteId?: string; akteName?: string; nameNeu?: boolean; kontext?: PlanKontext; umgebung?: string; sudoSperre?: 'projekt' | 'geraet'; vorgefunden?: string[] }): Promise<ProjektStand> {
    const g = { ...STANDARD_GRENZEN, ...(o.grenzen ?? {}) };
    const roh = await this.d.planen(o.ziel, o.kontext);
    if (!roh.length) throw new Error('Der Planer lieferte keine Etappen');
    const plan = begrenzePlan(roh, g.maxEtappen);
    const s: ProjektStand = {
      id: `sat-${randomUUID().slice(0, 8)}`, geraetId: o.geraetId, geraet: o.geraet, projekt: o.projekt, ziel: o.ziel,
      pruefBefehle: [...new Set((o.pruefBefehle ?? []).map(b => b.trim()).filter(Boolean))] /* v1390 doppelte (Build = Test) nur einmal */, grenzen: g, herkunft: o.herkunft, ownerId: o.ownerId,
      ...(o.gitUebernehmen && !o.verzeichnisNeu ? { gitUebernehmen: true } : {}), ...(o.akteId ? { akteId: o.akteId } : {}), ...(o.akteName ? { akteName: o.akteName } : {}), ...(o.umgebung ? { umgebung: o.umgebung } : {}), ...(o.sudoSperre === 'projekt' ? { sudoSperre: true } : {}), ...(o.vorgefunden?.length ? { vorgefunden: pfadeSicher(o.vorgefunden) } : {}), ...(o.kontext?.vorherige?.length || o.kontext?.bestand ? { bestehend: true } : {}), grenzenStand: 1394, status: 'wartet_owner', plan, nr: 0, erledigt: [], fixVersuch: 0, kostenUsd: 0, etappeKostenUsd: 0, start: this.jetzt(), aktualisiert: this.jetzt(),
    };
    const text = planFrage({ geraet: s.geraet, projekt: s.projekt, ziel: s.ziel, plan, pruefBefehle: s.pruefBefehle, g, gekuerzt: roh.length > plan.length, verzeichnisNeu: o.verzeichnisNeu, gitUebernehmen: s.gitUebernehmen, name: s.akteName, nameNeu: o.nameNeu, laeufeBisher: o.kontext?.vorherige?.length, umgebung: o.umgebung, sudoSperre: o.sudoSperre, vorgefunden: s.vorgefunden });
    await this.stelleFrage(s, 'plan', text);
    try { s.vorgangId = await this.d.vorgang?.anlegen(s); } catch { /* optional */ }
    this.sichere(s);
    this.d.logger.info({ id: s.id, geraet: s.geraet, projekt: s.projekt, etappen: plan.length }, 'v1387 Satelliten-Projekt geplant');
    return s;
  }

  private async stelleFrage(s: ProjektStand, art: FrageArt, text: string, mutation?: Mutation, installation?: { werkzeug: string; quelle: string; paket: string }, extra?: { ownerAbnahme?: boolean; pruefVorschlag?: string[] }): Promise<void> {
    const nonce = randomUUID();
    s.frage = { nonce, art, text, ...(mutation ? { mutation } : {}), ...(installation ? { installation } : {}), ...(extra?.ownerAbnahme ? { ownerAbnahme: true } : {}), ...(extra?.pruefVorschlag?.length ? { pruefVorschlag: extra.pruefVorschlag } : {}) };
    if (art !== 'plan') s.status = 'wartet_owner';
    this.sichere(s);
    await this.d.frage(s, text, nonce);
    if (art !== 'plan') await this.d.melde(s, text, 'frage').catch(() => undefined); // v1419 G3 — Rückfrage auch im Projektfaden (die Bestätigung selbst geht wie bisher)
    if (art !== 'plan') await this.d.vorgang?.stand?.(s, `Wartet auf dich: ${text.split('\n')[0]!.slice(0, 150)}`, true).catch(() => undefined);
  }

  /** Owner hat bestätigt (Bestätigungs-Queue ruft mit der Einmal-Kennung). Falsche oder alte Kennungen bewirken nichts. */
  antwort(id: string, nonce: string): Promise<boolean> {
    const s = this.staende.get(id);
    if (!s?.frage || s.frage.nonce !== nonce || s.status === 'fertig' || s.status === 'abgebrochen') return Promise.resolve(false);
    const f = s.frage;
    s.frage = undefined;
    return this.seriell(id, async () => {
      if (f.art === 'plan') {
        s.status = 'laeuft'; s.start = this.jetzt();
        // v1398 — Akte zuordnen bzw. anlegen (erst mit der Freigabe: abgelehnte Pläne legen keine Akte an)
        if (this.d.akte) { const a = await this.d.akte.zuordnen(s).catch((err: Error) => { this.d.logger.warn({ id: s.id, err: err.message }, 'v1398 Akte nicht zugeordnet'); return undefined; }); if (a) s.akteId = a; }
        await this.naechsteEtappe(s); return;
      }
      if (f.art === 'installieren' && f.installation) { await this.installiereUndWiederhole(s, f.installation); return; } // v1410 R3c
      if (f.art === 'mutation' && f.mutation) {
        const rest = s.plan.slice(s.nr);
        s.plan = [...s.plan.slice(0, s.nr), ...this.d.anwenden(rest, s.nr, f.mutation)];
        await this.d.melde(s, `Plan geändert nach deiner Bestätigung (${f.mutation.kind}); jetzt ${s.plan.length} Etappen.`);
      }
      if (f.art === 'weiter' && f.ownerAbnahme) { await this.ownerAbnahme(s); return; } // v1484 F1
      if (f.art === 'pruefung' && f.pruefVorschlag?.length) { await this.uebernimmPruefbefehle(s, f.pruefVorschlag); return; } // v1485 F2
      s.status = 'laeuft';
      await this.naechsteEtappe(s);
    }).then(() => true);
  }

  /**
   * v1454 — Rückfrage per „Nein“ abgelehnt oder unbeantwortet abgelaufen (Bestätigungs-Queue, egal ob Telegram, Web oder App).
   * Realfall 15.10.: ein abgelehnter Plan blieb ohne Ende „wartet auf dich“ — nur die Projektansicht kannte die Ablehnung.
   * Plan → abgebrochen; Installation/Planänderung abgelehnt → ohne sie weiter; „Weitermachen?“ abgelehnt oder jede Rückfrage
   * abgelaufen → angehalten (fortsetzbar). Falsche oder alte Kennungen bewirken nichts.
   */
  abgelehnt(id: string, nonce: string, wie: 'abgelehnt' | 'abgelaufen'): Promise<boolean> {
    const s = this.staende.get(id);
    if (!s?.frage || s.frage.nonce !== nonce || s.status === 'fertig' || s.status === 'abgebrochen') return Promise.resolve(false);
    const art = s.frage.art;
    if (art === 'plan') return this.stoppe(id, wie === 'abgelehnt' ? 'Plan vom Owner abgelehnt' : 'Plan nicht bestätigt (Rückfrage abgelaufen)');
    if (wie === 'abgelehnt' && (art === 'installieren' || art === 'mutation')) return this.weiterOhneAenderung(id);
    if (wie === 'abgelehnt' && art === 'pruefung') return this.ohneVorschlag(id); // v1485 F2
    s.frage = undefined;
    return this.seriell(id, async () => {
      await this.beende(s, 'angehalten', wie === 'abgelehnt' ? 'Owner: nicht weitermachen' : 'Rückfrage unbeantwortet abgelaufen');
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
        const e = er?.data as { status?: string; text?: string; kosten?: number; dauerMs?: number; fehler?: string; dateien?: string[]; dateienAnzahl?: number; dauerS?: number; changelogGeaendert?: boolean } | undefined;
        if (s.auftragId !== id) return;
        // v1426 — Ende-Daten wie beim Ereignis übernehmen (ältere Satelliten liefern sie nicht)
        await this.nachAuftrag(s, { typ: 'ereignis', art: 'auftrag', auftragId: id, status: (e?.status === 'fertig' ? 'fertig' : 'fehler'), titel: '', projekt: s.projekt, text: e?.text ?? '', kosten: e?.kosten, ...(e?.fehler ? { fehler: e.fehler } : {}), ...(Array.isArray(e?.dateien) ? { dateien: e!.dateien, dateienAnzahl: e!.dateienAnzahl } : {}), ...(typeof e?.dauerS === 'number' ? { dauerS: e.dauerS } : {}), ...(typeof e?.changelogGeaendert === 'boolean' ? { changelogGeaendert: e.changelogGeaendert } : {}) } as GeraetEreignis);
      });
    }
    return n;
  }

  // ── Ablauf ──────────────────────────────────────────────────

  private async naechsteEtappe(s: ProjektStand): Promise<void> {
    if (s.nr >= s.plan.length) { await this.beende(s, 'fertig'); return; }
    s.nr += 1; s.fixVersuch = 0; s.etappeKostenUsd = 0; s.etappeLauf = undefined;
    await this.starteAuftrag(s, etappenAuftrag({ ziel: s.ziel, plan: s.plan, nr: s.nr, pruefBefehle: s.pruefBefehle, bestehend: s.bestehend, vorgefunden: s.vorgefunden, umgebung: s.umgebung }), `Etappe ${s.nr}: ${s.plan[s.nr - 1]!.slice(0, 60)}`);
  }

  private async starteAuftrag(s: ProjektStand, auftrag: string, titel: string): Promise<void> {
    const grenze = grenzeErreicht({ kostenUsd: s.kostenUsd, startMs: s.start, jetztMs: this.jetzt(), g: s.grenzen });
    if (grenze) { await this.beende(s, 'angehalten', grenze); return; }
    // v1394 — mit Budget: Claude Code bekommt das Restbudget und hält es selbst ein (--max-budget-usd)
    const rest = s.grenzen.budgetUsd !== undefined ? Math.max(0.05, Number((s.grenzen.budgetUsd - s.kostenUsd).toFixed(2))) : undefined;
    const protokoll = { lauf: s.id, nr: s.nr, ...(s.fixVersuch ? { fix: s.fixVersuch } : {}), an: await this.protokollAn(s) }; // v1425
    if (!auftrag.includes('Projektregeln des Owners (gelten für jede Etappe)')) auftrag = `${auftrag}${konventionsBlock(await this.konventionen(s))}`; // v1426 — jede Etappe, jeder Fix, jeder Nachtrag; nach Warten aufs Gerät nicht doppelt
    // v1455 — Merge-Request-Modus: Zweig vor dem ersten Auftrag, Kommentare des Owners aus dem MR in den Auftrag
    if (!auftrag.includes('Startangabe: Ist das Projekt') && (!s.bestehend || await this.d.devAktiv?.(s).catch(() => false))) auftrag = `${auftrag}\n${START_REGEL}`; // v1460
    const vor: { hinweise?: string; meldung?: string } | undefined = await this.d.vorEtappe?.(s).catch((err: Error) => ({ meldung: `⚠️ Merge Request: ${err.message}` }));
    if (vor?.hinweise) auftrag = `${auftrag}${vor.hinweise}`;
    if (vor?.meldung) await this.d.melde(s, vor.meldung).catch(() => undefined);
    const r = await this.d.aktion(s.geraetId, 'auftrag_starten', { projekt: s.projekt, auftrag, titel, ...(rest !== undefined ? { max_kosten_usd: rest } : {}), ...(s.gitUebernehmen ? { git_uebernehmen: true } : {}), ...(s.sudoSperre ? { sudo_sperre: true } : {}), protokoll }, 150_000);
    const id = (r.data as { id?: string } | undefined)?.id;
    // v1415 — Realfall 13.10. 01:11: Etappe 2 sollte genau starten, als der Satellit für ein Update kurz weg war → Projekt angehalten.
    // Ein nicht verbundenes Gerät hält das Projekt nicht an: die Etappe startet, sobald es wieder da ist (höchstens 24 h).
    if (!r.success && /nicht verbunden|antwortete nicht/i.test(r.error ?? '')) {
      const erstes = !s.wartetAufGeraet;
      s.wartetAufGeraet = { auftrag, titel, seit: s.wartetAufGeraet?.seit ?? this.jetzt() };
      this.sichere(s);
      this.d.logger.info({ id: s.id, etappe: s.nr, geraet: s.geraet }, 'v1415 Etappe wartet auf das Gerät');
      if (erstes) {
        await this.d.melde(s, `⏳ ${s.geraet} ist gerade nicht verbunden — Etappe ${s.nr}/${s.plan.length} startet, sobald es wieder da ist.`);
        await this.d.vorgang?.stand?.(s, `Etappe ${s.nr}/${s.plan.length} wartet auf ${s.geraet}`, false).catch(() => undefined);
      }
      return;
    }
    if (!r.success || !id) { await this.beende(s, 'angehalten', `Auftrag nicht gestartet: ${r.error ?? 'keine Kennung'}`); return; }
    s.wartetAufGeraet = undefined;
    s.auftragId = id;
    s.etappeStart = this.jetzt();
    // v1397 — Ergebnis der Git-Übernahme melden (einmal; ältere Satelliten liefern nichts → ohne Meldung)
    const gitText = s.gitUebernehmen ? gitMeldung((r.data as { git?: GitErgebnis } | undefined)?.git) : undefined;
    s.gitUebernehmen = undefined;
    this.sichere(s);
    if (gitText) await this.d.melde(s, gitText);
    this.d.logger.info({ id: s.id, etappe: s.nr, fix: s.fixVersuch, auftrag: id }, 'v1387 Etappe gestartet');
    // v1392 — sichtbar machen, dass etwas läuft (Fix-Versuche haben ihre eigene Meldung)
    if (!s.fixVersuch) await this.d.melde(s, `▶ Etappe ${s.nr}/${s.plan.length} gestartet: ${s.plan[s.nr - 1]!.slice(0, 140)}`);
    await this.d.vorgang?.stand?.(s, `Etappe ${s.nr}/${s.plan.length}${s.fixVersuch ? ` (Fix ${s.fixVersuch})` : ''} läuft seit ${uhrzeit(s.etappeStart)}`, false).catch(() => undefined);
  }

  private async nachAuftrag(s: ProjektStand, e: GeraetEreignis): Promise<void> {
    if (s.auftragId !== e.auftragId || s.status !== 'laeuft') return;
    s.auftragId = undefined;
    const kosten = e.kosten ?? 0;
    s.kostenUsd += kosten; s.etappeKostenUsd += kosten;
    s.letzterText = (e.text ?? '').slice(-400);
    // v1417 G1 — Bericht der Etappe sammeln (Fix-Versuche ergänzen Dateien und Dauer, der letzte Text zählt)
    const alt = s.etappeLauf;
    const dateien = [...new Set([...(alt?.dateien ?? []), ...(e.dateien ?? [])])].slice(0, 200);
    s.etappeLauf = { text: (e.text ?? '').slice(-8000) || alt?.text || '', dateien, dateienAnzahl: Math.max(dateien.length, (alt?.dateienAnzahl ?? 0) + (e.dateienAnzahl ?? 0) - (e.dateien?.filter(d => alt?.dateien.includes(d)).length ?? 0)), dauerS: (alt?.dauerS ?? 0) + (e.dauerS ?? 0) };
    this.sichere(s);
    const etappe = s.plan[s.nr - 1]!;
    if (e.status === 'abgebrochen') { await this.beende(s, 'abgebrochen', 'Auftrag am Gerät abgebrochen'); return; }
    // v1426 — Projektregel „CHANGELOG pflegen": fehlt der Eintrag nach einer erfolgreichen Etappe, einmal nachtragen lassen (vor der Abnahme).
    // Ältere Satelliten melden changelogGeaendert nicht → keine Prüfung (nie raten).
    if (e.changelogGeaendert === true) s.changelogOk = s.nr;
    if (e.status === 'fertig' && e.changelogGeaendert === false && s.changelogOk !== s.nr && s.changelogNachgetragen !== s.nr) {
      const k = await this.konventionen(s);
      if (changelogPflicht(k)) {
        s.changelogNachgetragen = s.nr; this.sichere(s);
        this.d.logger.info({ id: s.id, etappe: s.nr }, 'v1426 Changelog fehlt — Nachtrag');
        await this.d.melde(s, `📝 Etappe ${s.nr}: CHANGELOG.md wurde nicht ergänzt — Alfred lässt den Eintrag nachtragen (Projektregel).`);
        await this.starteAuftrag(s, changelogAuftrag({ nr: s.nr, etappe, format: k?.changelog?.format, zusammenfassung: s.etappeLauf?.text }), `Etappe ${s.nr}: Changelog nachtragen`);
        return;
      }
    }

    if (!s.pruefBefehle.length) {
      // v1410 R3c — auch ohne Abnahme: meldet Claude Code ein fehlendes Werkzeug, zuerst nach der Installation fragen
      const fehltOhne = fehlendeWerkzeuge(e.text ?? '', '').filter(w => !(s.installiertGefragt ?? []).includes(w));
      if (fehltOhne.length) { await this.frageInstallation(s, fehltOhne[0]!, etappe); return; }
      // v1485 F2 — Prüfbefehle aus dem Projekt vorschlagen (einmal je Lauf, nur nach einer fertigen Etappe)
      if (e.status === 'fertig' && !s.pruefVorschlagAus && this.d.pruefVorschlag) {
        const v = await this.d.pruefVorschlag(s).catch(() => undefined);
        if (v?.befehle.length) { await this.frageVorschlag(s, etappe, v); return; }
      }
      await this.ohnePruefbefehle(s, etappe, e.status === 'fertig');
      return;
    }
    await this.pruefeEtappe(s, etappe, e.text ?? '');
  }

  /** Etappe ohne Prüfbefehle: vermerken (ungeprüft), dev neu starten, den Owner fragen. */
  private async ohnePruefbefehle(s: ProjektStand, etappe: string, fertig: boolean): Promise<void> {
    // ohne Abnahme keine automatische nächste Etappe (Owner-Entscheidung 12.10.)
    await this.vermerke(s, { ok: fertig, geprueft: false });
    // v1460 — gerade ohne Abnahme prüft der Owner selbst: dev am Gerät vorher neu starten
    if (fertig) { const dz = await this.d.devNachEtappe?.(s).catch((err: Error) => `⚠️ dev: ${err.message}`); if (dz) await this.d.melde(s, dz).catch(() => undefined); }
    // v1484 F1 — Realfall 16.10. (Heizölpreis): ohne Prüfbefehle wurde nie gepusht, die Commits blieben lokal. Das Ja zu einer
    // fertigen Etappe ist jetzt die Abnahme durch den Owner (Push/MR wie bei einer geprüften Etappe); die Frage sagt das.
    if (fertig) {
      const letzte = s.nr >= s.plan.length;
      await this.stelleFrage(s, 'weiter', `Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" fertig (ungeprüft: keine Prüfbefehle, ${s.etappeKostenUsd.toFixed(2)} USD).\nJa = du nimmst sie ab: wie bei einer geprüften Etappe wird gepusht bzw. der Merge Request nachgeführt (wenn ein Repo eingerichtet ist), ${letzte ? 'dann ist das Projekt fertig' : 'dann folgt die nächste Etappe'}. Nein = das Projekt hält an.\n${letzte ? 'Abnehmen und abschließen?' : 'Abnehmen und weitermachen?'}`, undefined, undefined, { ownerAbnahme: true });
      return;
    }
    await this.stelleFrage(s, 'weiter', `Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" mit Fehler beendet (ungeprüft, ${s.etappeKostenUsd.toFixed(2)} USD). Mit der nächsten Etappe weitermachen?`);
  }

  /** Abnahme mit den Prüfbefehlen am Gerät: grün → abgenommen (Push/MR), rot → Installation oder Fix-Versuch. */
  private async pruefeEtappe(s: ProjektStand, etappe: string, text: string): Promise<void> {
    const p = await this.d.aktion(s.geraetId, 'pruefen_befehl', { pruefungen: s.pruefBefehle.map(b => ({ art: 'befehl', ziel: b, cwd: s.projekt, timeoutS: 600 })) }, PRUEF_TIMEOUT_MS);
    const ok = p.success && (p.data as { ok?: boolean } | undefined)?.ok === true;
    const protokoll = p.display ?? p.error ?? 'keine Ausgabe';
    if (ok) {
      await this.vermerke(s, { ok: true, geprueft: true, protokoll });
      const nach = await this.d.nachAbnahme?.(s).catch((err: Error) => `⚠️ Nach der Abnahme: ${err.message}`); // v1434 B13
      await this.d.melde(s, `✅ Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" abgenommen${s.fixVersuch ? ` nach ${s.fixVersuch} Fix-Versuch(en)` : ''} · ${s.etappeKostenUsd.toFixed(2)} USD, gesamt ${s.kostenUsd.toFixed(2)} USD.${nach ? `\n${nach}` : ''}`);
      await this.d.vorgang?.schritt(s, `Etappe ${s.nr} abgenommen: ${etappe.slice(0, 160)}`).catch(() => undefined);
      await this.umplanen(s, true, protokoll);
      return;
    }
    // v1410 R3c — fehlt ein Werkzeug, statt Fix-Versuch fragen, ob installiert werden soll (einmal je Werkzeug)
    const fehlt = fehlendeWerkzeuge(text, protokoll).filter(w => !(s.installiertGefragt ?? []).includes(w));
    if (fehlt.length) { s.letztesProtokoll = protokoll; await this.frageInstallation(s, fehlt[0]!, etappe); return; }
    await this.nachRot(s, etappe, protokoll);
  }

  /** Abnahme rot: Fix-Versuch oder (nach maxFixVersuche) Rückfrage. */
  private async nachRot(s: ProjektStand, etappe: string, protokoll: string): Promise<void> {
    if (s.fixVersuch < s.grenzen.maxFixVersuche) {
      s.fixVersuch += 1;
      await this.d.melde(s, `🔧 Etappe ${s.nr}: Abnahme rot — Fix-Versuch ${s.fixVersuch}/${s.grenzen.maxFixVersuche}.`);
      await this.starteAuftrag(s, fixAuftrag({ ziel: s.ziel, nr: s.nr, etappe, versuch: s.fixVersuch, pruefprotokoll: protokoll, vorgefunden: s.vorgefunden }), `Etappe ${s.nr}: Fix ${s.fixVersuch}`);
      return;
    }
    await this.vermerke(s, { ok: false, geprueft: true, protokoll });
    await this.stelleFrage(s, 'weiter', `❌ Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" nach ${s.grenzen.maxFixVersuche} Fix-Versuchen weiter rot:\n${protokoll.slice(0, 800)}\nTrotzdem mit der nächsten Etappe weitermachen? (Sonst: stoppen)`);
  }

  /** v1485 F2 — Rückfrage: vorgeschlagene Prüfbefehle übernehmen? */
  private async frageVorschlag(s: ProjektStand, etappe: string, v: { befehle: string[]; quelle?: string }): Promise<void> {
    this.d.logger.info({ id: s.id, etappe: s.nr, befehle: v.befehle, quelle: v.quelle }, 'v1485 Prüfbefehle vorgeschlagen');
    await this.stelleFrage(s, 'pruefung', `🧪 Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 100)}" fertig. Für dieses Projekt sind keine Prüfbefehle eingerichtet.\nVorschlag${v.quelle ? ` aus ${v.quelle}` : ''}: ${v.befehle.join(' · ')}\nJa = übernehmen: Sie prüfen gleich diese Etappe und danach jede weitere. Grün wird automatisch abgenommen und gepusht, rot führt wie gewohnt zu einem Fix-Versuch. Sie gelten auch für spätere Läufe.\nNein = ohne Prüfbefehle weiter: du nimmst jede Etappe selbst ab.`, undefined, undefined, { pruefVorschlag: v.befehle });
  }

  /** v1485 F2 — Ja: Prüfbefehle übernehmen (Lauf + Akte) und die fertige Etappe gleich damit abnehmen. */
  private async uebernimmPruefbefehle(s: ProjektStand, befehle: string[]): Promise<void> {
    s.pruefBefehle = [...befehle]; s.status = 'laeuft'; this.sichere(s);
    this.d.logger.info({ id: s.id, etappe: s.nr, befehle }, 'v1485 Prüfbefehle übernommen');
    const fehler = await this.d.pruefBefehleSetzen?.(s, befehle).then(() => undefined, (err: Error) => err.message);
    if (fehler) this.d.logger.warn({ id: s.id, err: fehler }, 'v1485 Prüfbefehle nicht in die Akte geschrieben');
    await this.d.melde(s, `🧪 Prüfbefehle übernommen: ${befehle.join(' · ')}${fehler ? ' (nur für diesen Lauf, Projektakte nicht geändert)' : ''}. Sie prüfen jetzt Etappe ${s.nr}.`);
    await this.pruefeEtappe(s, s.plan[s.nr - 1]!, s.etappeLauf?.text ?? s.letzterText ?? '');
  }

  /** v1485 F2 — Nein: ohne Prüfbefehle weiter (Owner-Abnahme), in diesem Lauf nicht noch einmal vorschlagen. */
  ohneVorschlag(id: string): Promise<boolean> {
    const s = this.staende.get(id);
    if (s?.frage?.art !== 'pruefung') return Promise.resolve(false);
    s.frage = undefined;
    return this.seriell(id, async () => {
      s.pruefVorschlagAus = true; s.status = 'laeuft';
      await this.ohnePruefbefehle(s, s.plan[s.nr - 1]!, true);
    }).then(() => true);
  }

  /** v1484 F1 — Etappe ohne Prüfbefehle: das Ja des Owners ist die Abnahme. Bleibt ungeprüft (kein Auto-Merge, kein Auto-dev), wird aber gepusht. */
  private async ownerAbnahme(s: ProjektStand): Promise<void> {
    const etappe = s.plan[s.nr - 1]!;
    s.erledigt = s.erledigt.map(x => x.nr === s.nr ? { ...x, ownerAbgenommen: true } : x);
    s.status = 'laeuft'; this.sichere(s);
    this.d.logger.info({ id: s.id, etappe: s.nr }, 'v1484 Etappe vom Owner abgenommen (ohne Prüfbefehle)');
    const nach = await this.d.nachAbnahme?.(s, { ohneDev: true }).catch((err: Error) => `⚠️ Nach der Abnahme: ${err.message}`); // dev lief schon vor der Frage
    await this.d.melde(s, `✅ Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" von dir abgenommen (ungeprüft) · ${s.etappeKostenUsd.toFixed(2)} USD, gesamt ${s.kostenUsd.toFixed(2)} USD.${nach ? `\n${nach}` : ''}`);
    await this.d.vorgang?.schritt(s, `Etappe ${s.nr} vom Owner abgenommen: ${etappe.slice(0, 160)}`).catch(() => undefined);
    await this.umplanen(s, true, 'Etappe vom Owner abgenommen (keine Prüfbefehle eingerichtet)');
  }

  private async vermerke(s: ProjektStand, o: { ok: boolean; geprueft: boolean; protokoll?: string }): Promise<void> {
    const l = s.etappeLauf;
    const commit = await this.letzterEtappenCommit(s);
    const eintrag: EtappenErgebnis = {
      nr: s.nr, etappe: s.plan[s.nr - 1]!, ok: o.ok, geprueft: o.geprueft, fixVersuche: s.fixVersuch, kostenUsd: s.etappeKostenUsd, text: s.letzterText ?? '',
      ...(l?.text ? { zusammenfassung: l.text } : {}), ...(l ? { dateien: l.dateien, dateienAnzahl: l.dateienAnzahl, dauerS: l.dauerS } : {}),
      ...(commit ? { commit } : {}), ...(o.geprueft && o.protokoll !== undefined ? { abnahme: { ok: o.ok, protokoll: o.protokoll.slice(0, 2000) } } : {}),
    };
    s.erledigt = [...s.erledigt.filter(x => x.nr !== s.nr), eintrag];
    this.sichere(s);
    await this.protokolliere(s, eintrag); // v1425 — nach dem Commit der Etappe (der Etappen-Commit ist oben schon erkannt)
  }

  private async konventionen(s: ProjektStand): Promise<Konventionen | undefined> {
    try { return this.d.konventionen ? await this.d.konventionen(s) : undefined; } catch { return undefined; }
  }

  private async protokollAn(s: ProjektStand): Promise<boolean> {
    try { return this.d.protokollAn ? await this.d.protokollAn(s) : true; } catch { return true; }
  }

  /** v1425 — Etappenbericht ins Projekt (Satellit schreibt und committet nur den Protokollordner); ältere Satelliten: nur Logzeile. */
  private async protokolliere(s: ProjektStand, e: EtappenErgebnis): Promise<void> {
    const an = await this.protokollAn(s);
    const bericht = etappenBerichtText({ lauf: s.id, geraet: s.geraet, ziel: s.ziel, plan: s.plan, zeit: new Date(this.jetzt()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC', e });
    const r = await this.d.aktion(s.geraetId, 'projekt_protokoll', { projekt: s.projekt, lauf: s.id, nr: s.nr, an, bericht, nachricht: `docs(alfred): Protokoll Etappe ${s.nr}/${s.plan.length} (${s.id})` }, 60_000).catch((err: Error) => ({ success: false, error: err.message, data: undefined, display: undefined }));
    if (r.success) this.d.logger.info({ id: s.id, etappe: s.nr, an, ...(r.data as object | undefined) }, 'v1425 Etappenprotokoll im Projekt');
    else this.d.logger.info({ id: s.id, etappe: s.nr, an, fehler: r.error }, 'v1425 Etappenprotokoll nicht geschrieben');
  }

  /** v1417 G1 — Commit dieser Etappe (Etappen-Auftrag committet mit „Etappe <n>: …"); nur lesend, Fehler egal. */
  private async letzterEtappenCommit(s: ProjektStand): Promise<{ sha: string; titel: string } | undefined> {
    const r = await this.d.aktion(s.geraetId, 'projekt_lesen', { projekt: s.projekt }, 30_000).catch(() => undefined);
    // v1426 — nicht nur der neueste: Changelog-Nachtrag und Protokoll (v1425) committen danach mit eigenem Text
    const c = (r?.data as { commits?: Array<{ sha: string; message: string }> } | undefined)?.commits?.slice(0, 5).find(x => new RegExp(`^Etappe ${s.nr}\\b`).test(x.message));
    if (!c) return undefined;
    if (s.erledigt.some(x => x.nr !== s.nr && x.commit?.sha === c.sha)) return undefined;
    return { sha: c.sha, titel: c.message.split('\n')[0]!.slice(0, 160) };
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

  /**
   * v1391 — angehaltenes Projekt fortsetzen (Realfall 12.10.: Etappe 1 scheiterte am fehlenden Verzeichnis, „resume" gab es nicht,
   * Alfred plante ein neues Projekt mit neuer Bestätigung). Die aktuelle Etappe startet neu; die Planfreigabe gilt weiter,
   * Budget und Zeitgrenze ebenso — ist eine erreicht, gibt es kein Fortsetzen.
   */
  fortsetzenNach(id: string): Promise<{ ok: boolean; grund?: string }> {
    const s = this.staende.get(id);
    if (!s) return Promise.resolve({ ok: false, grund: `Projekt ${id} unbekannt` });
    if (s.status !== 'angehalten') return Promise.resolve({ ok: false, grund: `Projekt ${id} ist ${s.status}, nicht angehalten` });
    const grenze = grenzeErreicht({ kostenUsd: s.kostenUsd, startMs: s.start, jetztMs: this.jetzt(), g: s.grenzen });
    if (grenze) return Promise.resolve({ ok: false, grund: `${grenze} — neues Projekt mit höherer Grenze starten` });
    return this.seriell(id, async () => {
      s.status = 'laeuft'; s.grund = undefined;
      if (s.nr === 0) { await this.naechsteEtappe(s); return; }
      s.fixVersuch = 0;
      await this.d.melde(s, `▶ Fortgesetzt mit Etappe ${s.nr}/${s.plan.length}.`);
      await this.starteAuftrag(s, etappenAuftrag({ ziel: s.ziel, plan: s.plan, nr: s.nr, pruefBefehle: s.pruefBefehle, bestehend: s.bestehend, vorgefunden: s.vorgefunden, umgebung: s.umgebung }), `Etappe ${s.nr}: ${s.plan[s.nr - 1]!.slice(0, 60)}`);
    }).then(() => ({ ok: true }));
  }

  /** Owner will ohne die vorgeschlagene Änderung weiter (Rückfrage „mutation" abgelehnt). */
  weiterOhneAenderung(id: string): Promise<boolean> {
    const s = this.staende.get(id);
    if (!s?.frage || (s.frage.art !== 'mutation' && s.frage.art !== 'installieren')) return Promise.resolve(false);
    const art = s.frage.art;
    s.frage = undefined;
    return this.seriell(id, async () => {
      s.status = 'laeuft';
      if (art === 'mutation') { await this.naechsteEtappe(s); return; }
      // v1410 R3c — ohne Installation: wie bisher Fix-Versuch (mit Abnahme) bzw. Frage nach der nächsten Etappe (ohne)
      const etappe = s.plan[s.nr - 1]!;
      if (s.pruefBefehle.length) { await this.nachRot(s, etappe, s.letztesProtokoll ?? ''); return; }
      await this.vermerke(s, { ok: false, geprueft: false });
      await this.stelleFrage(s, 'weiter', `Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 120)}" ohne Installation (ungeprüft). Mit der nächsten Etappe weitermachen?`);
    }).then(() => true);
  }

  /** v1410 R3c — Rückfrage „Werkzeug installieren?" (Owner 13.10.: jede Installation einzeln bestätigt). */
  private async frageInstallation(s: ProjektStand, werkzeug: string, etappe: string): Promise<void> {
    const v = installVorschlag(werkzeug, s.umgebung);
    s.installiertGefragt = [...(s.installiertGefragt ?? []), werkzeug];
    this.d.logger.info({ id: s.id, etappe: s.nr, werkzeug, ...v }, 'v1410 Installation zur Rückfrage');
    await this.stelleFrage(s, 'installieren', `🧩 Etappe ${s.nr}/${s.plan.length} „${etappe.slice(0, 100)}" braucht „${werkzeug}“, das auf ${s.geraet} fehlt.\nInstallieren mit ${v.quelle}: ${v.paket}?\nJa: installieren und die Etappe neu starten · Nein / „weiter ohne Installation": normaler Fix-Versuch.`, undefined, { werkzeug, ...v });
  }

  /** v1410 R3c — nach dem Ja: installieren (Geräteaktion), Ergebnis melden, Etappe neu starten; Fehlschlag hält das Projekt an. */
  private async installiereUndWiederhole(s: ProjektStand, i: { werkzeug: string; quelle: string; paket: string }): Promise<void> {
    await this.d.melde(s, `🧩 Installiere ${i.paket} (${i.quelle}) auf ${s.geraet} …`);
    const r = await this.d.aktion(s.geraetId, 'installieren', { quelle: i.quelle, paket: i.paket }, 16 * 60_000);
    if (!r.success) { await this.beende(s, 'angehalten', `Installation von ${i.paket} fehlgeschlagen: ${String(r.error ?? '').slice(0, 300)}`); return; }
    await this.d.melde(s, `✅ ${i.paket} installiert — Etappe ${s.nr} startet neu.`);
    s.status = 'laeuft';
    await this.starteAuftrag(s, etappenAuftrag({ ziel: s.ziel, plan: s.plan, nr: s.nr, pruefBefehle: s.pruefBefehle, bestehend: s.bestehend, vorgefunden: s.vorgefunden, umgebung: s.umgebung ? `${s.umgebung} · neu installiert: ${i.werkzeug}` : undefined }), `Etappe ${s.nr}: nach Installation`);
  }

  private async beende(s: ProjektStand, status: 'fertig' | 'abgebrochen' | 'angehalten', grund?: string): Promise<void> {
    s.status = status; s.grund = grund; s.auftragId = undefined; s.frage = undefined;
    this.sichere(s);
    const ok = s.erledigt.filter(x => x.ok).length;
    const text = `${status === 'fertig' ? '🏁 Projekt fertig' : status === 'angehalten' ? '⏸ Projekt angehalten' : '⏹ Projekt abgebrochen'}: „${s.ziel.slice(0, 120)}" auf ${s.geraet}${grund ? ` — ${grund}` : ''}. ${ok}/${s.plan.length} Etappen ok, ${s.kostenUsd.toFixed(2)} USD, ${Math.round((this.jetzt() - s.start) / 60_000)} min. Verzeichnis: ${s.projekt}`;
    this.d.logger.info({ id: s.id, status, grund, etappenOk: ok, etappen: s.plan.length, kostenUsd: s.kostenUsd }, 'v1387 Satelliten-Projekt beendet');
    await this.d.melde(s, text, 'ende');
    await this.d.vorgang?.abschliessen(s, text).catch(() => undefined);
    await this.d.akte?.beruehren?.(s).catch(() => undefined); // v1398
    if (status === 'fertig') void this.d.nachLauf?.(s).catch((err: Error) => this.d.logger.warn({ id: s.id, err: err.message }, 'v1437 nach dem Lauf fehlgeschlagen'));
  }
}

/** v1397 — Antwort des Satelliten auf git_uebernehmen */
export interface GitErgebnis { status?: string; commit?: string; grosse?: string[]; fehler?: string }

export function gitMeldung(g: GitErgebnis | undefined): string | undefined {
  if (!g?.status) return undefined;
  if (g.status === 'schon-repository') return 'Git: Das Verzeichnis liegt bereits in einem Git-Repository — die Etappen committen dort.';
  if (g.status === 'ohne-git') return 'Git: Auf dem Gerät ist Git nicht installiert — das Projekt läuft ohne Commits weiter.';
  if (g.fehler) return `Git: Repository angelegt, Ausgangs-Commit fehlgeschlagen (${g.fehler}) — die Etappen committen trotzdem.`;
  const gross = g.grosse?.length ? ` Nicht aufgenommen (über 10 MB): ${g.grosse.slice(0, 5).join(', ')}${g.grosse.length > 5 ? ` und ${g.grosse.length - 5} weitere` : ''}.` : '';
  return `Git: Repository angelegt${g.commit ? `, Ausgangs-Commit ${g.commit} „Stand vor Alfred"` : ' (Verzeichnis war leer)'}.${gross}`;
}
