/**
 * Spec Infrastruktur-Vorhaben, I4 (Owner 22.10.2026 „I4 wie vorgeschlagen umsetzen“) — Ausführungsmotor für freigegebene Changes.
 *
 * Deterministisch, ohne Modell: Schritt für Schritt ausführen, prüfen, Ergebnis speichern (übersteht Neustarts), CMDB pflegen.
 * Bei Abweichung gilt, was im freigegebenen Plan steht: anhalten (Incident, Meldung, Rückweg NUR als Frage an den Owner —
 * Owner 22.10. „Rückweg nur vorschlagen, dann auf Freigabe warten“), rueckweg (im Plan freigegeben → selbst) oder weiter.
 * Owner-Schritte warten auf das Ja des Owners. Höchstens ein laufender Change je betroffenem Asset.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CmdbChangeRequest, SkillResultAttachment } from '@alfred/types';
import { befehlsklasse } from '../fernzugriff/regeln.js';
import { schwaerze } from '../fernzugriff/kaefig.js';
import { leseDocker, LINUX_BEFEHLE } from './sammler.js';
import { unaufgeloesterVerweis, vorgaengerWertMangel, datenWerte, geheimNamen, kuerzeDaten, laufBericht, loeseAuf, merkeVerlauf, restWirkung, rueckwegSchritte, textErfuellt, wirkt, MAX_AUSGABE, type ChangeLauf, type SchrittErgebnis } from './change-lauf.js';
import { ohneGeheimnisse } from './tresor.js';
import { randomBytes } from 'node:crypto';
import { aktionsArt, ZEITLIMIT_STANDARD_S, type ChangeSchritt, type Pruefung } from './change-schritte.js';

export interface MotorDeps {
  owner: () => string | undefined;
  itsm: {
    liste(o: string): Promise<CmdbChangeRequest[]>;
    hole(o: string, id: string): Promise<CmdbChangeRequest | null>;
    motorSetze(o: string, id: string, d: { status?: 'in_progress' | 'completed' | 'failed' | 'rolled_back' | 'cancelled'; lauf: unknown; result?: string; linkedIncidentId?: string }): Promise<CmdbChangeRequest>;
    /** v1640 — nie gestarteten Change verwerfen */
    verwerfen?(o: string, id: string, grund: string): Promise<CmdbChangeRequest>;
  };
  /** Skill-Aktion als Owner ausführen (Skill-Sandbox mit Zeitlimit) */
  fuehreAus: (skill: string, input: Record<string, unknown>, timeoutMs: number) => Promise<{ success: boolean; data?: unknown; display?: string; error?: string }>;
  fernLesen: (zugang: string, befehl: string, timeoutMs: number, streng?: boolean) => Promise<string>;
  /** v1652 — Datei-Prüfung: nur Typ und Größe (fester stat-Befehl), unabhängig von der Geheimnis-Sperre für Inhalte */
  fernDatei?: (zugang: string, pfad: string, timeoutMs: number) => Promise<string>;
  fernAusfuehren: (zugang: string, befehl: string, alsRoot: boolean, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  netz: {
    http: (url: string, timeoutMs: number) => Promise<{ status: number; text: string }>;
    port: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    dns: (name: string) => Promise<string[]>;
    /** v1683 — Auflösung über öffentliche Resolver ohne lokalen Cache */
    dnsFrisch?: (name: string) => Promise<string[]>;
    ping: (host: string) => Promise<boolean>;
  };
  cmdbProtokoll?: (assetId: string, text: string) => Promise<void>;
  /** hosts: je Quelle die vom Change berührten Hosts (fernzugriff: Zugangsnamen) — Teil-Erfassung statt aller Zugänge */
  entdecke?: (quellen: string[], hosts?: Record<string, string[]>) => Promise<string[]>;
  incident?: {
    anlegen(o: string, d: { titel: string; text: string; schwere: string; assetIds: string[] }): Promise<string>; notiz(o: string, id: string, text: string): Promise<void>;
    /** v1620 — Change-Ende ohne Restwirkung: eigenen Incident lösen (Lösung = Bericht) bzw. bei Restwirkung hochstufen */
    loese?(o: string, id: string, loesung: string): Promise<void>; hochstufen?(o: string, id: string): Promise<void>;
  };
  /** Owner-Meldung; `anhaenge` (Dokument-Vorlagen V2: PDF/DOCX des Abnahmeprotokolls) gehen als Dateien mit */
  melde?: (text: string, dringend: boolean, anhaenge?: SkillResultAttachment[]) => Promise<void>;
  /** Frage an den Owner (Button); nach dem Ja ruft die Queue den Skill infrastruktur mit `params` auf */
  frage?: (description: string, params: Record<string, unknown>) => Promise<boolean>;
  /** v1688 — veraltete Owner-Fragen in App/Telegram zurückziehen (nach Steuern und vor einer neuen Frage) */
  fragenAufraeumen?: () => Promise<void>;
  /** S1 — ein Lauf hielt an, scheiterte oder rollte zurück (Standard-Vorlagen werden daraufhin gesperrt) */
  nachStoerung?: (o: string, c: CmdbChangeRequest, grund: string) => Promise<void>;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  /** I4b — darf der Change jetzt starten (Fenster, Sperren, Ankündigung)? Verschickt fällige Ankündigungen. */
  zeitplan?: (o: string, c: CmdbChangeRequest) => Promise<{ jetzt: boolean; grund: string; startAb?: string }>;
  /** I4b Teil 5 — nach Abschluss eines Changes eines Vorhabens: Soll/Ist-Abgleich (Text für die Meldung) */
  nachAbschluss?: (o: string, c: CmdbChangeRequest) => Promise<string | undefined>;
  /**
   * Dokument-Vorlagen V2 — nach dem Ende jedes Changes (gespeicherter Stand): Abnahmeprotokoll erzeugen; Rückgabe = Zusatzzeile der
   * Abschlussmeldung. Darf den Abschluss nie scheitern lassen: Fehler werden zur Zeile, nach `nachEndeZeitMs` meldet der Motor trotzdem.
   */
  nachEnde?: (o: string, c: CmdbChangeRequest, status: 'completed' | 'failed' | 'rolled_back' | 'cancelled') => Promise<string | { zeile: string; anhaenge?: SkillResultAttachment[] } | undefined>;
  /** Zeitgrenze für nachEnde (Standard 25 s); danach kommt das Ergebnis als eigene Meldung */
  nachEndeZeitMs?: number;
  /** I4b Teil 2 — IDs der Assets, die von den gegebenen abhängen (CMDB, eingehende Beziehungen) */
  abhaengigeIds?: (o: string, ids: string[]) => Promise<string[]>;
  /** I4b — Start/Ende/Störung an die Empfänger der Benachrichtigungsregeln */
  ereignis?: (o: string, c: CmdbChangeRequest, z: 'start' | 'ende' | 'stoerung', text: string) => Promise<void>;
  /** I4c — Tresor (nur hier werden Werte gelesen) und Geheimnis-Dateien am Ziel-Host */
  tresor?: { lies(o: string, name: string, wofuer: string): Promise<string> };
  geheimDatei?: { schreiben(zugang: string, pfad: string, wert: string): Promise<void>; entfernen(zugang: string, pfad: string): Promise<boolean> };
  jetzt?: () => number;
  schlafe?: (ms: number) => Promise<void>;
  /** Wartezeiten (für Tests verkürzbar) */
  takt?: { pruefAbstandMs: number; pruefVersuche: number; taskAbstandMs: number; wartenAbstandMs: number };
}

/** Skills, deren Discovery-Quelle nach einem Change neu gelesen wird (Skill → CMDB-Quelle) */
const QUELLE: Record<string, string> = { proxmox: 'proxmox', docker: 'docker', unifi: 'unifi', nginx_proxy_manager: 'nginx_proxy_manager', pfsense: 'pfsense', mikrotik: 'mikrotik', cloudflare_dns: 'cloudflare_dns', fernzugriff: 'fernzugriff' };
/**
 * Realfall 19.11.2026 (2cfde1a2, eccb5401, 8907c9b9): die volle Fernzugriff-Erfassung nach einem Change lief nie in den 120 s des
 * cmdb-Skills durch („timed out“) und arbeitete unbemerkt weiter. Nach einem Change nur die Zugänge erfassen, die seine Schritte berührt
 * haben (Parameter name; Verweise {{…}} zählen nicht).
 */
export function beruehrteHosts(schritte: ChangeSchritt[]): Record<string, string[]> {
  const fz = new Set<string>();
  for (const s of schritte) {
    const n = (s.parameter as Record<string, unknown> | undefined)?.name;
    if (s.skill === 'fernzugriff' && typeof n === 'string' && n.trim() && !n.includes('{{')) fz.add(n.trim());
  }
  return { fernzugriff: [...fz].sort() };
}
const FRAGE_GUELTIG_MS = 24 * 3_600_000;
/**
 * PDF, DOCX und Kopie auf pve2 dauern Sekunden. beende() hält bis dahin abhängige Changes (nächstes Serien-Glied), den Takt nach einem
 * Abbruch und die Chat-Antwort auf „abbrechen“ auf — darum knapp; was länger dauert, folgt als eigene Meldung.
 */
const NACH_ENDE_ZEIT_MS = 25_000;
const hash = (n: string) => createHash('sha256').update(n).digest('hex');

/** Warum ein Change mit {{change:…}}-Verweisen nicht startet */
type VorgaengerSperre = { id: string; art: 'geaendert' | 'zurueck' | 'offen' | 'keine' | 'wert'; grund: string };

/** Final-Welle N-6 — Meldungstext je Grund (nur wo Neuplanung hilft, wird sie genannt) */
function wartenText(c: CmdbChangeRequest, s: VorgaengerSperre): string {
  const k = c.id.slice(0, 8); const v = s.id.slice(0, 8);
  const kopf = `⏸️ Change ${k} („${c.title}“)`;
  switch (s.art) {
    case 'geaendert': return `${kopf} wartet: Vorgänger ${v} nach der Planung geändert — ${k} neu planen (change_aendern) und neu freigeben.`;
    case 'zurueck': return `${kopf} wartet: Vorgänger ${v} zurückgenommen (Rückweg begonnen) — seine Werte gelten nicht mehr. ${k} startet nicht; abbrechen oder nach erneutem Aufbau neu planen.`;
    case 'offen': return `${kopf} wartet, bis Vorgänger ${v} fertig ist (Lauf noch nicht abgeschlossen).`;
    case 'keine': return `${kopf} wartet: verweist auf Change ${v}, der nicht in seinen Abhängigkeiten steht — ${k} neu planen (change_aendern) und neu freigeben.`;
    case 'wert': return `${kopf} startet nicht: ${s.grund}. Kein Schritt ausgeführt. ${k} abbrechen oder neu planen; was der Vorgänger nicht angelegt hat, von Hand klären.`;
  }
}

/**
 * v1688 — Realfall 26.10. (Matrix J): Nach Korrekturen ab dem Haltepunkt standen in der App weiter die Fragen „Schritt 30 … erledigt?“
 * neben der gültigen „Schritt 37 … erledigt?“; ein Ja auf die falsche hätte nichts bewirkt oder verwirrt. Eine offene Owner-Frage ist
 * veraltet, sobald der Change nicht mehr genau an diesem Schritt mit genau dieser Frage (Nonce) wartet.
 */
/** v1692 — darf der Schritt, an dem der Lauf angehalten hat, übersprungen werden? (liest/prüft/wartet nur, hat nichts bewirkt, kein späterer Verweis) */
export function ueberspringbar(l: ChangeLauf, c: CmdbChangeRequest): boolean {
  const schritte = (c.schritte ?? []) as ChangeSchritt[];
  const s = schritte.find(x => x.nr === l.schritt);
  const e = l.ergebnisse.find(x => x.nr === l.schritt);
  if (!s || e?.aktionOk || e?.teilweise) return false;
  if (!(s.art === 'pruefung' || s.art === 'warten' || (s.art === 'aktion' && !!s.skill && !!s.aktion && aktionsArt(s.skill, s.aktion, s.parameter) === 'lesen'))) return false;
  return !schritte.some(x => x.nr > s.nr && new RegExp(`\\{\\{\\s*schritt${s.nr}\\.`).test(JSON.stringify(x)));
}

export function ownerFrageVeraltet(c: CmdbChangeRequest | undefined | null, params: { schritt?: unknown; freigabe?: unknown }): boolean {
  if (!c || c.status !== 'in_progress') return true;
  const l = c.lauf as ChangeLauf | undefined;
  if (!l || l.phase !== 'wartet_owner' || !l.frage || l.frage.art !== 'owner_schritt') return true;
  return Number(l.frage.schritt) !== Number(params.schritt) || l.frage.hash !== hash(String(params.freigabe ?? ''));
}

/** v1729 — Anteile des Grundtakts für die ersten Prüfungen eines Warte-Schritts (10 s → 2, 2, 3, 5 s, danach 10 s) */
const WARTEN_STAFFEL = [0.2, 0.2, 0.3, 0.5];
const ZEIT = Symbol('zeitueberschreitung');

/**
 * Dokument-Vorlagen: eine gespeicherte Plan-Korrektur (lauf.korrektur, gesetzt von der ITSM-Ablage) als Verlaufseintrag merken, sobald der
 * Owner über den korrigierten Change entscheidet (weiter, abbrechen, Rückweg). Gleiche Korrektur (Zeitpunkt) nur einmal.
 */
function merkeKorrektur(l: ChangeLauf): void {
  const k = l.korrektur;
  if (!k || (l.verlauf ?? []).some(e => e.art === 'plan_geaendert' && e.zeit === k.zeit)) return;
  merkeVerlauf(l, { zeit: k.zeit, art: 'plan_geaendert', schritt: k.abSchritt, text: `Plan ab Schritt ${k.abSchritt} korrigiert${k.aktionGeaendert ? ' (Aktion am Haltepunkt geändert)' : ''}` });
}

export class ChangeMotor {
  private readonly laufend = new Set<string>();
  /**
   * Realfall 21.11. (3af9930c L6-E): starte() setzte in_progress/laeuft und wartete auf Meldung und Ereignis, bevor weiter() den
   * Change in `laufend` eintrug. Ein gleichzeitiges anstossen() (Abschluss von L6-D) hielt ihn in dieser Lücke als „nach Neustart“
   * an, während der echte Lauf weiterarbeitete — zwei Läufe auf einem Change, zwei Halt-Incidents, einer blieb verwaist.
   * `startend` belegt den Change ab dem ersten Schritt von starte() bis weiter() ihn übernommen hat.
   */
  private readonly startend = new Set<string>();
  private belegt(id: string): boolean { return this.laufend.has(id) || this.startend.has(id); }
  private readonly takt: NonNullable<MotorDeps['takt']>;
  constructor(private readonly d: MotorDeps) {
    this.takt = d.takt ?? { pruefAbstandMs: 5_000, pruefVersuche: 6, taskAbstandMs: 3_000, wartenAbstandMs: 10_000 };
  }

  private jetzt(): number { return this.d.jetzt?.() ?? Date.now(); }
  private iso(): string { return new Date(this.jetzt()).toISOString(); }
  private schlafe(ms: number): Promise<void> { return this.d.schlafe ? this.d.schlafe(ms) : new Promise(r => setTimeout(r, ms)); }
  private log(msg: string, daten: Record<string, unknown>): void { this.d.protokoll?.(msg, daten); }

  /** Freigabe vorhanden, gleich dem aktuellen Fingerabdruck, und die Schritte im Speicher sind dieselben wie beim Start. */
  private freigabeDeckt(frisch: CmdbChangeRequest, start: CmdbChangeRequest): boolean {
    if (!frisch.freigabeFingerabdruck || frisch.freigabeFingerabdruck !== frisch.fingerabdruck || frisch.fingerabdruck !== start.fingerabdruck) return false;
    try { return JSON.stringify(frisch.schritte ?? []) === JSON.stringify(start.schritte ?? []); } catch { return false; }
  }

  /** Anzahl Changes, deren Schritte gerade aktiv laufen (Selbstupdate wartet darauf). */
  aktiv(): number { return this.laufend.size; }

  /**
   * v1975 — Live-Anzeige (Owner 28.11.): Changes in Arbeit mit aktuellem Schritt, seit wann er läuft und seinem Zeitlimit.
   * `aktiv` = der Motor führt gerade Schritte aus (sonst wartet der Change, z. B. angehalten oder auf den Owner).
   */
  async uebersicht(): Promise<Array<{ id: string; titel: string; phase: string; schritt: number; schritte: number; schrittTitel?: string; schrittSeit?: string; zeitlimitS?: number; start?: string; grund?: string; aktiv: boolean }>> {
    const o = this.d.owner(); if (!o) return [];
    const alle = await this.d.itsm.liste(o).catch(() => [] as CmdbChangeRequest[]);
    return alle.filter(c => c.status === 'in_progress').map(c => {
      const l = (c.lauf ?? undefined) as ChangeLauf | undefined;
      const schritte = (c.schritte ?? []) as ChangeSchritt[];
      const s = l ? schritte.find(x => x.nr === l.schritt) : undefined;
      return {
        id: c.id, titel: c.title, phase: l?.phase ?? 'unbekannt', schritt: l?.schritt ?? 0, schritte: schritte.length,
        ...(s?.titel ? { schrittTitel: s.titel.slice(0, 160) } : {}),
        ...(l?.schrittSeit ? { schrittSeit: l.schrittSeit } : {}),
        ...(typeof s?.zeitlimitS === 'number' ? { zeitlimitS: s.zeitlimitS } : {}),
        ...(l?.start ? { start: l.start } : {}),
        ...(l?.grund ? { grund: l.grund.slice(0, 300) } : {}),
        aktiv: this.laufend.has(c.id),
      };
    });
  }
  /** v1604 — „wartet auf angehaltenen Change“ nur einmal je Paar melden */
  private readonly wartenGemeldet = new Set<string>();

  /**
   * Fällige freigegebene Changes starten, unterbrochene nach einem Neustart behandeln, abgebrochene abschließen.
   * Aufruf: nach jeder Freigabe, beim Start und über das Job-Register.
   */
  async anstossen(): Promise<string[]> {
    const o = this.d.owner(); if (!o) return [];
    const alle = (await this.d.itsm.liste(o)).filter(c => c.schritte?.length);
    const gestartet: string[] = [];
    // v1969 — Assets der in DIESEM Durchgang gestarteten Changes: `alle` ist ein Stand vor dem Durchgang (Realfall 26.11.: ffdfb929 und
    // 347d2aea starteten in derselben Millisekunde auf VM 144, beide waren beim Laden noch `approved`)
    const imDurchgang = new Set<string>();
    for (const c of alle) {
      if (this.belegt(c.id)) continue;
      const l = c.lauf as ChangeLauf | undefined;
      // Owner hat im Web/Chat abgebrochen, während der Change angehalten war → Bericht nachtragen
      if (c.status === 'cancelled' && l && l.phase !== 'fertig') { await this.beende(o, c, l, 'cancelled', 'vom Owner abgebrochen'); continue; }
      if (c.status === 'in_progress' && l && (l.phase === 'laeuft' || l.phase === 'rueckweg')) { await this.nachNeustart(o, c, l); continue; }
      // v1661 — korrigierter angehaltener Change: nach der Freigabe des neuen Plans am Haltepunkt weiter
      if (c.status === 'in_progress' && l?.phase === 'angehalten' && l.korrektur && c.freigabeFingerabdruck && c.freigabeFingerabdruck === c.fingerabdruck) {
        this.log('I4 Korrigierter Change läuft weiter', { id: c.id, abSchritt: l.korrektur.abSchritt });
        await this.d.melde?.(`▶️ Korrektur freigegeben: ${c.title} (${c.id.slice(0, 8)}) läuft ab Schritt ${l.korrektur.abSchritt} weiter`, false);
        await this.steuern(o, c.id, 'wiederholen', 'freigabe');
        gestartet.push(c.id);
        for (const a of c.affectedAssetIds) imDurchgang.add(a);
        continue;
      }
      if (c.status !== 'approved') continue;
      if (c.scheduledAt && Date.parse(c.scheduledAt) > this.jetzt()) continue;
      const abh = (c.abhaengigVon ?? []).map(id => alle.find(x => x.id === id));
      if (abh.some(x => !x || x.status !== 'completed')) continue;
      // V3 Fix 2 (N-1) — ein Change, dessen {{change:<id>…}} sicher anhalten würde, startet gar nicht erst (sonst liefen die Schritte
      // davor und hinterließen einen halb umgesetzten Change)
      const gesperrt = await this.vorgaengerGrund(o, c);
      if (gesperrt) {
        this.log('V3 Change wartet (Vorgänger)', { id: c.id, vorgaenger: gesperrt.id, art: gesperrt.art, grund: gesperrt.grund });
        // Final-Welle N-5 — Fingerabdruck des wartenden Change im Schlüssel: nach Neuplanung wird erneut gemeldet
        const k = `${c.id}:${c.fingerabdruck ?? ''}:vorgaenger:${gesperrt.id}:${gesperrt.grund}`;
        if (!this.wartenGemeldet.has(k)) {
          this.wartenGemeldet.add(k);
          await this.d.melde?.(wartenText(c, gesperrt), true);
        }
        continue;
      }
      // Realfall 22.10. (B hielt an einer reinen Prüfung an und sperrte damit T und A3, auf die er selbst wartet): ein angehaltener Change
      // belegt seine Assets nur, wenn er schon etwas verändert hat
      const hatGewirkt = (x: CmdbChangeRequest) => { const l = x.lauf as ChangeLauf | undefined; const st = (x.schritte ?? []) as ChangeSchritt[]; return (l?.ergebnisse ?? []).some(e => (e.ok || e.aktionOk || e.teilweise) && st.some(s => s.nr === e.nr && wirkt(s))); };
      const belegende = alle.filter(x => x.id !== c.id && x.status === 'in_progress' && (x.lauf as ChangeLauf | undefined)?.phase !== 'fertig' && ((x.lauf as ChangeLauf | undefined)?.phase !== 'angehalten' || hatGewirkt(x)) && x.affectedAssetIds.some(a => c.affectedAssetIds.includes(a)));
      if (c.affectedAssetIds.some(a => imDurchgang.has(a))) { this.log('I4 Change wartet (Asset im selben Durchgang belegt)', { id: c.id }); continue; }
      if (belegende.length) {
        this.log('I4 Change wartet (Asset belegt)', { id: c.id, durch: belegende.map(x => x.id) });
        // v1604 — Realfall 23.10.: 9527d97f wartete still auf den angehaltenen 4f2642ab, der wiederum 9527d97f brauchte. Ein angehaltener
        // Change löst sich nie von selbst → dem Owner einmal sagen, worauf der freigegebene wartet und wie es weitergeht.
        // v1685 — auch ein auf den Owner wartender Change belegt (Realfall 26.10.: J1 wartete still auf J bei Owner-Schritt 19)
        for (const x of belegende.filter(x => ['angehalten', 'wartet_owner'].includes(String((x.lauf as ChangeLauf | undefined)?.phase)))) {
          const k = `${c.id}:${x.id}`;
          if (this.wartenGemeldet.has(k)) continue;
          this.wartenGemeldet.add(k);
          const wartet = (x.lauf as ChangeLauf | undefined)?.phase === 'wartet_owner';
          await this.d.melde?.(`⏸️ ${c.title} (${c.id.slice(0, 8)}) ist freigegeben, startet aber nicht: ${x.title} (${x.id.slice(0, 8)}) ${wartet ? `wartet bei Schritt ${(x.lauf as ChangeLauf).schritt} auf dich` : 'ist angehalten'} und belegt dasselbe Gerät.${wartet ? '\nBraucht der wartende Change diesen hier, gehört die Änderung als Korrektur in ihn selbst (Plan ab dem Haltepunkt ändern).' : ''}

Weiter geht es erst, wenn du über ${x.id.slice(0, 8)} entscheidest (im Chat):
• „Change ${x.id.slice(0, 8)} Schritt wiederholen“
• „Change ${x.id.slice(0, 8)} abbrechen“ (ohne Rückweg — Wirkung bleibt)
• „Change ${x.id.slice(0, 8)} Rückweg ausführen“`, true);
        }
        continue;
      }
      if (this.d.zeitplan) {
        const z = await this.d.zeitplan(o, c).catch(err => ({ jetzt: false, grund: `Zeitplan nicht prüfbar: ${(err as Error).message}` }));
        if (!z.jetzt) { this.log('I4b Change wartet', { id: c.id, grund: z.grund, startAb: (z as { startAb?: string }).startAb }); continue; }
      }
      gestartet.push(c.id);
      for (const a of c.affectedAssetIds) imDurchgang.add(a);
      void this.starte(o, c).catch(err => this.log('I4 Motorfehler', { id: c.id, fehler: (err as Error).message }));
    }
    return gestartet;
  }

  private async starte(o: string, c: CmdbChangeRequest): Promise<void> {
    // Realfall 21.11. — synchron belegen (vor dem ersten await), freigeben erst, wenn weiter() den Change in `laufend` hat
    if (this.belegt(c.id)) return;
    this.startend.add(c.id);
    let uebergeben = false;
    try {
      // v1651 — nach Neuplanung eines angehaltenen Changes gehört dessen Halt-Incident weiter zum Lauf (wird am Ende gelöst)
      const lauf: ChangeLauf = { phase: 'laeuft', schritt: 1, start: this.iso(), ergebnisse: [], ...(c.linkedIncidentId ? { incidentId: c.linkedIncidentId } : {}) };
      const akt = await this.d.itsm.motorSetze(o, c.id, { status: 'in_progress', lauf });
      this.log('I4 Change gestartet', { id: c.id, titel: c.title, schritte: (c.schritte ?? []).length });
      await this.d.melde?.(`▶️ Change gestartet: ${c.title} (${c.id.slice(0, 8)}, ${(c.schritte ?? []).length} Schritte)`, false);
      await this.d.ereignis?.(o, akt, 'start', `Die Wartung „${c.title}“ beginnt jetzt${c.ausfallMinuten ? ` (erwartete Unterbrechung bis ${c.ausfallMinuten} min)` : ''}.`).catch(() => undefined);
      // weiter() trägt den Change synchron (vor seinem ersten await) in `laufend` ein — erst danach startend freigeben
      const lauft = this.weiter(o, akt, lauf, true);
      this.startend.delete(c.id); uebergeben = true;
      await lauft;
    } finally {
      if (!uebergeben) this.startend.delete(c.id);
    }
  }

  /** Schritte ab dem aktuellen ausführen, bis Ende, Owner-Schritt, Anhalten oder Abbruch. */
  async weiter(o: string, c0: CmdbChangeRequest, lauf: ChangeLauf, ausStarte = false): Promise<void> {
    if (this.laufend.has(c0.id) || (!ausStarte && this.startend.has(c0.id))) return;
    this.laufend.add(c0.id);
    let fertig = false;
    try {
      const schritte = (c0.schritte ?? []) as ChangeSchritt[];
      for (const s of schritte) {
        if (s.nr < lauf.schritt || lauf.ergebnisse.some(e => e.nr === s.nr && e.ok)) continue;
        const frisch = await this.d.itsm.hole(o, c0.id);
        if (!frisch || frisch.status === 'cancelled') { await this.beende(o, frisch ?? c0, lauf, 'cancelled', 'vom Owner abgebrochen'); return; }
        // Sicherheitsbefund 22.10.: vor jedem Schritt (auch nach Neustart/Owner-Ja) — Freigabe deckt genau den gespeicherten Plan
        if (!this.freigabeDeckt(frisch, c0)) { await this.halte(o, c0, lauf, 'Freigabe deckt den gespeicherten Plan nicht mehr (Fingerabdruck geändert) — nichts ausgeführt'); return; }
        lauf.schritt = s.nr; lauf.phase = 'laeuft'; lauf.schrittSeit = this.iso(); // v1975
        await this.d.itsm.motorSetze(o, c0.id, { lauf });
        if (s.art === 'owner') { await this.frageOwner(o, c0, lauf, s); return; }
        const vorher = lauf.nurPruefung?.nr === s.nr ? lauf.nurPruefung : undefined;
        delete lauf.nurPruefung;
        // V3 — Ergebnisse abgeschlossener Vorgänger für {{change:<id>.schrittN.feld}} (vor jedem Schritt frisch gelesen)
        const vorgaenger = await this.vorgaenger(o, c0);
        const e = await this.schritt(s, lauf.ergebnisse, { o, wofuer: `Change ${c0.id.slice(0, 8)} Schritt ${s.nr}`, vorgaenger }, vorher);
        lauf.ergebnisse = [...lauf.ergebnisse.filter(x => x.nr !== s.nr), e];
        await this.d.itsm.motorSetze(o, c0.id, { lauf });
        this.log('I4 Schritt', { id: c0.id, nr: s.nr, ok: e.ok, pruefung: e.pruefung?.ok, fehler: e.fehler?.slice(0, 200) });
        if (wirkt(s) && (e.ok || e.aktionOk || e.teilweise)) for (const a of c0.affectedAssetIds) await this.d.cmdbProtokoll?.(a, `Change ${c0.id.slice(0, 8)} „${c0.title}“ Schritt ${s.nr}: ${s.titel}${e.ok ? '' : ' (Prüfung gescheitert)'}`).catch(() => undefined);
        if (e.ok) continue;
        if (s.beiFehler === 'weiter') continue;
        const grund = `Schritt ${s.nr} „${s.titel}“: ${e.fehler ?? e.pruefung?.text ?? 'gescheitert'}`;
        if (s.beiFehler === 'rueckweg') { await this.rueckweg(o, c0, lauf, grund); return; }
        await this.halte(o, c0, lauf, grund);
        return;
      }
      // Abschluss: Discovery der berührten Quellen (die CMDB muss den neuen Zustand selbst sehen), Bericht
      const quellen = [...new Set(schritte.filter(wirkt).map(s => QUELLE[s.skill ?? '']).filter((q): q is string => !!q))];
      const disc = quellen.length && this.d.entdecke ? await this.d.entdecke(quellen, beruehrteHosts(schritte.filter(wirkt))).catch(err => [`Discovery: ${(err as Error).message}`]) : [];
      await this.beende(o, c0, lauf, 'completed', undefined, disc);
      fertig = true;
    } finally {
      this.laufend.delete(c0.id);
    }
    // Realfall 22.10. (733bbe87 wartete 6 min auf den 10-Minuten-Takt): abhängige Changes gleich nach dem Abschluss anstoßen
    if (fertig) await this.anstossen().catch(err => this.log('I4 Motorfehler', { id: c0.id, fehler: (err as Error).message }));
  }

  /** Einen Schritt ausführen und prüfen (Aktion, Prüfung oder Warten). */
  /**
   * I4c — Aktion mit Tresor-Werten: Werte erst jetzt lesen, Geheimnis-Dateien am Host anlegen (stdin, 600) und danach in jedem Fall
   * entfernen; Ausgaben ohne die Werte. Ohne Tresor-Verweise ist das ein gewöhnlicher Aufruf.
   */
  private async mitGeheimnissen(z: { o: string; wofuer: string; vorgaenger?: Map<string, SchrittErgebnis[] | string> } | undefined, skill: string, aktion: string, parameter: Record<string, unknown>, ergebnisse: SchrittErgebnis[], timeoutMs: number): Promise<{ ok: boolean; ausgabe?: string; daten?: unknown; fehler?: string; teilweise?: boolean }> {
    const namen = geheimNamen(parameter);
    const werte = new Map<string, string>(); const dateien = new Map<string, string>(); const angelegt: Array<{ zugang: string; pfad: string }> = [];
    try {
      if (namen.werte.length || namen.dateien.length) {
        if (!z || !this.d.tresor) return { ok: false, fehler: 'Tresor nicht verfügbar' };
        for (const n of [...namen.werte, ...namen.dateien]) if (!werte.has(n)) werte.set(n, await this.d.tresor.lies(z.o, n, z.wofuer));
        if (namen.dateien.length) {
          if (skill !== 'fernzugriff' || aktion !== 'ausfuehren' || !this.d.geheimDatei) return { ok: false, fehler: '{{geheimdatei:…}} nur in Fernzugriff-Befehlen' };
          const zugang = String(parameter.name ?? '');
          for (const n of namen.dateien) {
            const pfad = `/run/alfred-g-${randomBytes(8).toString('hex')}`;
            await this.d.geheimDatei.schreiben(zugang, pfad, werte.get(n)!);
            angelegt.push({ zugang, pfad }); dateien.set(n, pfad);
          }
        }
      }
      const p = loeseAuf(parameter, ergebnisse, { werte, dateien }, z?.vorgaenger);
      if (p.fehler) return { ok: false, fehler: p.fehler };
      // V3 Fix 1 (I-2) — harter Wächter direkt vor dem Skill-Aufruf
      const rest = unaufgeloesterVerweis(p.wert);
      if (rest) return { ok: false, fehler: rest };
      const r = await this.aktion(skill, aktion, p.wert, timeoutMs);
      const geheim = [...werte.values()];
      if (!geheim.length) return r;
      const rein = (t?: string) => (t === undefined ? undefined : ohneGeheimnisse(t, geheim));
      let daten = r.daten; try { daten = JSON.parse(ohneGeheimnisse(JSON.stringify(r.daten ?? null), geheim)); } catch { daten = undefined; }
      return { ok: r.ok, ...(r.ausgabe !== undefined ? { ausgabe: rein(r.ausgabe)! } : {}), ...(daten !== undefined && daten !== null ? { daten } : {}), ...(r.fehler !== undefined ? { fehler: rein(r.fehler)! } : {}), ...(r.teilweise ? { teilweise: true } : {}) };
    } finally {
      for (const a of angelegt) {
        const ok = await this.d.geheimDatei!.entfernen(a.zugang, a.pfad).catch(() => false);
        if (!ok) { this.log('I4c Geheimnis-Datei nicht entfernt', { zugang: a.zugang, pfad: a.pfad }); await this.d.melde?.(`⚠️ Geheimnis-Datei ${a.pfad} auf ${a.zugang} konnte nicht entfernt werden — bitte prüfen.`, true); }
      }
    }
  }

  /**
   * V3 — Ergebnisse der abgeschlossenen Changes in der Abhängigkeits-Hülle (abhaengigVon, transitiv) für {{change:<id>…}}.
   * Gilt nur ein Vorgänger, der completed ist, dessen Lauf fertig ist und keinen Rückweg begonnen hat (Fix 1, I-1) und dessen
   * freigegebener Plan genau dem beim Planen festgehaltenen Abdruck entspricht (Fix 1, C-1) — sonst fehlt er bzw. trägt den Grund;
   * ein Verweis darauf hält den Schritt an. Ohne Verweis im Plan: leer, kein Lesen.
   */
  private async vorgaenger(o: string, c: CmdbChangeRequest): Promise<Map<string, SchrittErgebnis[] | string>> {
    const aus = new Map<string, SchrittErgebnis[] | string>();
    if (!/\{\{\s*change:/.test(JSON.stringify(c.schritte ?? []))) return aus;
    const festgehalten = (c.pruefung as { zusatz?: { vorgaengerAbdruck?: Record<string, string> } } | undefined)?.zusatz?.vorgaengerAbdruck ?? {};
    const gesehen = new Set<string>([c.id]);
    const offen = [...(c.abhaengigVon ?? [])];
    while (offen.length) {
      const id = offen.pop()!;
      if (gesehen.has(id)) continue;
      gesehen.add(id);
      const v = await this.d.itsm.hole(o, id).catch(() => null);
      if (!v || v.id !== id) continue;
      offen.push(...(v.abhaengigVon ?? []));
      const l = v.lauf as ChangeLauf | undefined;
      if (v.status !== 'completed' || l?.phase !== 'fertig' || (l.rueckweg?.length ?? 0) > 0) continue;
      const fp = festgehalten[id];
      if (!fp || v.fingerabdruck !== fp || v.freigabeFingerabdruck !== fp) { aus.set(id, 'Vorgänger nach der Planung geändert — abhängigen Change neu planen'); continue; }
      aus.set(id, l.ergebnisse ?? []);
    }
    return aus;
  }

  /**
   * V3 Fix 2 (N-1) — erster Vorgänger, auf den der Plan verweist und der keine Werte liefern darf (mit Grund).
   * Final-Welle I1 — zusätzlich jeder referenzierte WERT (Schritte, Prüfung, Rückweg) nach den Laufzeit-Regeln: fehlt einer oder ist er
   * unzulässig, startet der Change nicht (sonst liefen z. B. Lösch-Schritte davor und erst ein späterer Schritt hielte an).
   */
  private async vorgaengerGrund(o: string, c: CmdbChangeRequest): Promise<VorgaengerSperre | undefined> {
    const ids = [...new Set([...JSON.stringify(c.schritte ?? []).matchAll(/\{\{\s*change:([A-Za-z0-9_-]{1,64})\./g)].map(m => m[1]!))];
    if (!ids.length) return undefined;
    const vg = await this.vorgaenger(o, c);
    for (const id of ids) {
      const v = vg.get(id);
      if (typeof v === 'string') return { id, art: 'geaendert', grund: v };
      if (!v) {
        // N-6 — Grund unterscheiden: zurückgenommen, noch nicht fertig, keine Abhängigkeit
        const x = await this.d.itsm.hole(o, id).catch(() => null);
        const l = x?.lauf as ChangeLauf | undefined;
        if (!x || x.id !== id) return { id, art: 'keine', grund: 'nicht abgeschlossen oder keine Abhängigkeit' };
        if ((l?.rueckweg?.length ?? 0) > 0 || l?.phase === 'rueckweg') return { id, art: 'zurueck', grund: 'zurückgenommen (Rückweg begonnen)' };
        // abgeschlossen und fertig, aber nicht in der Abhängigkeits-Hülle → nur durch Neuplanung lösbar
        if (x.status === 'completed' && l?.phase === 'fertig') return { id, art: 'keine', grund: 'keine Abhängigkeit (nicht in abhaengigVon)' };
        return { id, art: 'offen', grund: 'nicht abgeschlossen' };
      }
    }
    const m = vorgaengerWertMangel(c.schritte ?? [], vg);
    if (m) return { id: m.cid, art: 'wert', grund: `Wert ${m.feld} aus Change ${m.cid.slice(0, 8)} Schritt ${m.nr} ${m.art === 'fehlt' ? 'fehlt' : 'ist unzulässig'} — ${m.text}` };
    return undefined;
  }

  async schritt(s: ChangeSchritt, ergebnisse: SchrittErgebnis[], z?: { o: string; wofuer: string; vorgaenger?: Map<string, SchrittErgebnis[] | string> }, vorher?: { ausgabe?: string; daten?: unknown }): Promise<SchrittErgebnis> {
    const e: SchrittErgebnis = { nr: s.nr, ok: false, start: this.iso() };
    const fertig = (x: Partial<SchrittErgebnis>): SchrittErgebnis => ({ ...e, ...x, ende: this.iso() });
    try {
      if (s.art === 'aktion') {
        const r = vorher && s.pruefung
          ? { ok: true, ...(vorher.ausgabe !== undefined ? { ausgabe: vorher.ausgabe } : {}), ...(vorher.daten !== undefined ? { daten: vorher.daten } : {}) }
          : await this.mitGeheimnissen(z, s.skill!, s.aktion!, s.parameter ?? {}, ergebnisse, s.zeitlimitS * 1000);
        if (!r.ok) return fertig({ fehler: r.fehler, ...(r.ausgabe ? { ausgabe: r.ausgabe } : {}), ...(r.teilweise ? { teilweise: true, daten: kuerzeDaten(r.daten) } : {}) });
        const basis = { aktionOk: true, ausgabe: r.ausgabe?.slice(0, MAX_AUSGABE), daten: kuerzeDaten(r.daten) };
        if (!s.pruefung) return fertig({ ...basis, ok: true });
        // v1787 — Realfall 10.11. (a053cec2 Schritt 5): GC per systemd-run lief im Hintergrund, die Prüfung „active (exited)“ gab nach
        // 26 s auf (feste Versuchszahl) — trotz zeitlimitS 14400. Der Rückweg setzte die ZFS-Reserve zurück, der laufende GC scheiterte.
        // Bei einem langen Zeitlimit (über dem Standard) wartet die Prüfung jetzt wie ein Warte-Schritt bis zum Zeitlimit; „abbruch“ endet sofort.
        if (s.zeitlimitS > ZEITLIMIT_STANDARD_S) {
          const wb = this.takt.wartenAbstandMs, t0 = Date.now();
          const versuche = Math.max(1, Math.floor((s.zeitlimitS * 1000) / wb)) + WARTEN_STAFFEL.length;
          const pr = await this.pruefeMitWiederholung(s.pruefung, [...ergebnisse, { ...e, ...basis, ok: true }], versuche, i => Math.min(wb, Math.round((WARTEN_STAFFEL[i - 1] ?? 1) * wb)), t0 + s.zeitlimitS * 1000, z?.vorgaenger);
          const sek = Math.round((Date.now() - t0) / 1000);
          return fertig({ ...basis, ok: pr.ok, pruefung: pr, ...(pr.ok ? {} : { fehler: pr.text.startsWith('Abbruch') ? `Nach ${sek} s abgebrochen: ${pr.text}` : `Prüfung nach ${sek} s (Zeitlimit ${s.zeitlimitS} s) nicht erfüllt: ${pr.text}` }) });
        }
        const pr = await this.pruefeMitWiederholung(s.pruefung, [...ergebnisse, { ...e, ...basis, ok: true }], this.takt.pruefVersuche, this.takt.pruefAbstandMs, undefined, z?.vorgaenger, s.zeitlimitS);
        return fertig({ ...basis, ok: pr.ok, pruefung: pr, ...(pr.ok ? {} : { fehler: `Prüfung nicht erfüllt: ${pr.text}` }) });
      }
      if (s.art === 'pruefung') {
        const pr = await this.pruefeMitWiederholung(s.pruefung!, ergebnisse, this.takt.pruefVersuche, this.takt.pruefAbstandMs, undefined, z?.vorgaenger, s.zeitlimitS);
        return fertig({ ok: pr.ok, pruefung: pr, ...(pr.ok ? {} : { fehler: `Prüfung nicht erfüllt: ${pr.text}` }) });
      }
      if (s.art === 'warten') {
        if (s.sekunden && !s.pruefung) { await this.schlafe(s.sekunden * 1000); return fertig({ ok: true, ausgabe: `${s.sekunden} s gewartet` }); }
        if (s.sekunden) await this.schlafe(s.sekunden * 1000);
        // v1729 — gestaffelt: die ersten Prüfungen nach 2/2/3/5 s, danach im Grundtakt (10 s); Ende spätestens am Zeitlimit.
        // Kurze Wartezeiten („Dienst wieder oben“) waren sonst nie schneller als 10 s.
        const basis = this.takt.wartenAbstandMs;
        const versuche = Math.max(1, Math.floor((s.zeitlimitS * 1000) / basis)) + WARTEN_STAFFEL.length;
        const t0 = Date.now();
        const pr = await this.pruefeMitWiederholung(s.pruefung!, ergebnisse, versuche, i => Math.min(basis, Math.round((WARTEN_STAFFEL[i - 1] ?? 1) * basis)), t0 + s.zeitlimitS * 1000, z?.vorgaenger);
        // v1723 — Realfall 01.11. (a4c1b1e8 Schritte 59/69): ein Abbruch nach 10 s hieß „Bedingung nach 14400 s nicht erfüllt“
        const sek = Math.round((Date.now() - t0) / 1000);
        return fertig({ ok: pr.ok, pruefung: pr, ...(pr.ok ? {} : { fehler: pr.text.startsWith('Abbruch') ? `Nach ${sek} s abgebrochen: ${pr.text}` : `Bedingung nach ${sek} s (Zeitlimit ${s.zeitlimitS} s) nicht erfüllt: ${pr.text}` }) });
      }
      return fertig({ fehler: `Schritt-Art ${s.art} kann der Motor nicht selbst ausführen` });
    } catch (err) {
      return fertig({ fehler: (err as Error).message.slice(0, 500) });
    }
  }

  /** Skill-Aktion (Fernzugriff über den internen Weg; Proxmox-Aufgaben bis zum Ende verfolgt). */
  private async aktion(skill: string, aktion: string, p: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; ausgabe?: string; daten?: unknown; fehler?: string; teilweise?: boolean }> {
    if (skill === 'fernzugriff' && (aktion === 'lesen' || aktion === 'ausfuehren')) {
      const name = String(p.name ?? ''); const befehl = String(p.befehl ?? '');
      // v1723 — Realfall 01.11. (Element X 242f8d16 Schritt 12): „docker logs“ scheiterte im Käfig (kein Docker-Socket), der Schritt galt
      // trotzdem als erledigt. Als Change-AKTION ist ein Lesebefehl mit Exit ≠ 0 ein Fehlschlag (gewollte Fehlercodes: „|| true“ im Plan).
      // v1754 — Realfall 02.11. (886c0b3b Schritt 6): lesen mit befehle=[…] (ohne befehl) lief als leerer Befehl → „nie erlaubt“.
      // Jetzt der Reihe nach, jeder streng; die Ausgaben mit Kopfzeile wie beim Skill.
      const liste = aktion === 'lesen' && !befehl.trim() && Array.isArray(p.befehle) ? (p.befehle as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
      if (liste.length) {
        const teile: string[] = [];
        for (const b of liste) teile.push(`${name}$ ${b}\n${await this.d.fernLesen(name, b, timeoutMs, true)}`);
        const t = teile.join('\n');
        return { ok: true, ausgabe: t, daten: { ausgabe: t.trim().slice(0, 2000) } };
      }
      if (aktion === 'lesen' || befehlsklasse(befehl) === 'lesen') { const t = await this.d.fernLesen(name, befehl, timeoutMs, true); return { ok: true, ausgabe: t, daten: { ausgabe: t.trim().slice(0, 2000) } }; }
      let r = await this.d.fernAusfuehren(name, befehl, p.als_root !== false, timeoutMs);
      // v1764 — Realfall 06.11. (91eb7ee9 Schritte 5 und 11): der Gast-Agent der gerade gestarteten Windows-VM antwortete im Warteschritt
      // und war Sekunden später wieder weg („QEMU guest agent is not running“) — im Gast lief nichts. Bis zu 5× nach einer Pause nochmal.
      for (let n = 0; n < 5 && r.code !== 0 && /QEMU guest agent is not running/i.test(`${r.stdout}\n${r.stderr}`); n++) {
        this.log('v1764 Gast-Agent nicht bereit — Schritt wird wiederholt', { name, versuch: n + 2 });
        await this.schlafe(this.takt.wartenAbstandMs * 3);
        r = await this.d.fernAusfuehren(name, befehl, p.als_root !== false, timeoutMs);
      }
      // v1970 — Realfall 26.11. (347d2aea Schritt 5): das Skript stoppte postgreDEV und scheiterte danach an einer eigenen Prüfung; der
      // Schritt galt als „nicht ausgeführt“, „Rückweg ausführen“ fand nichts zurückzunehmen und postgreDEV blieb gestoppt. Ein ändernder
      // Befehl, der mit Exit ≠ 0 endet, ist gelaufen und kann teilweise gewirkt haben → sein Rückweg gehört dazu.
      return r.code === 0 ? { ok: true, ausgabe: r.stdout, daten: { exit: 0, ausgabe: r.stdout.slice(0, 2000) } } : { ok: false, ausgabe: `${r.stdout}\n${r.stderr}`.trim(), fehler: `Exit ${r.code}: ${r.stderr.trim().slice(-300)}`, teilweise: true, daten: { exit: r.code } };
    }
    // v1719 — Realfall 31.10. (8a26aed6 Schritt 73): kopieren lief mit der Skill-Vorgabe von 1 h statt mit dem Schrittlimit von 3 h und
    // brach nach 120 von 193 GB ab. Ohne eigenes timeout_s gilt bei Fernzugriff-Aktionen das Zeitlimit des Schritts.
    const zeit = skill === 'fernzugriff' && p.timeout_s === undefined ? { timeout_s: Math.floor(timeoutMs / 1000) } : {};
    const r = await this.d.fuehreAus(skill, { ...p, ...zeit, action: aktion }, timeoutMs);
    // v1630 — Realfall 24.10. (provision_vm: VM geklont, Anmeldung gescheitert, Rückweg ließ die VM stehen): liefert der Skill trotz
    // Fehlschlag Daten, hat er schon etwas angelegt — mitnehmen, damit Verweise und Rückweg greifen
    if (!r.success) return { ok: false, fehler: String(r.error ?? 'Skill-Fehler').slice(0, 500), ...(r.display ? { ausgabe: r.display } : {}), ...(r.data !== undefined && r.data !== null ? { daten: r.data, teilweise: true } : {}) };
    // Proxmox liefert bei Snapshots/Backups sofort eine Aufgabe (UPID) — bis zu ihrem Ende verfolgen
    const upid = (r.data as { upid?: unknown } | undefined)?.upid;
    if (skill === 'proxmox' && typeof upid === 'string' && upid.startsWith('UPID:')) {
      const bis = this.jetzt() + timeoutMs;
      for (;;) {
        const t = await this.d.fuehreAus('proxmox', { action: 'task_status', upid }, 30_000);
        const st = (t.data ?? {}) as { status?: string; exitstatus?: string };
        if (t.success && st.status === 'stopped') {
          // v1761 — Realfall 04.11. (36d4ae7b): PVE 9 startet jede VM ohne ms-cert=2023k mit „WARNINGS: 1“ (UEFI-2023-Hinweis) — die
          // Aufgabe ist gelungen; Warnungen nur vermerken, nicht als Fehlschlag werten
          if (st.exitstatus && /^WARNINGS: \d+$/.test(st.exitstatus)) return { ok: true, ausgabe: `${r.display ? `${r.display}\n` : ''}Proxmox-Aufgabe endete mit ${st.exitstatus} (gelungen, Warnung im Aufgabenprotokoll)`, daten: r.data };
          if (st.exitstatus && st.exitstatus !== 'OK') return { ok: false, fehler: `Proxmox-Aufgabe endete mit ${st.exitstatus}`, ausgabe: r.display };
          break;
        }
        if (this.jetzt() > bis) return { ok: false, fehler: `Proxmox-Aufgabe nach ${Math.round(timeoutMs / 1000)} s nicht fertig (${upid})`, ausgabe: r.display };
        await this.schlafe(this.takt.taskAbstandMs);
      }
    }
    return { ok: true, ...(r.display ? { ausgabe: r.display } : {}), daten: r.data };
  }

  private async pruefeMitWiederholung(p0: Pruefung, ergebnisse: SchrittErgebnis[], versuche: number, abstandMs: number | ((versuch: number) => number), fristMs?: number, vorgaenger?: Map<string, SchrittErgebnis[] | string>, zeitlimitS?: number): Promise<{ ok: boolean; text: string; versuche: number; ausgabe?: string }> {
    const aufgeloest = loeseAuf(p0, ergebnisse, undefined, vorgaenger);
    if (aufgeloest.fehler) return { ok: false, text: aufgeloest.fehler, versuche: 0 };
    const rest = unaufgeloesterVerweis(aufgeloest.wert);
    if (rest) return { ok: false, text: rest, versuche: 0 };
    const p = aufgeloest.wert;
    let letzter = ''; let ausgabe: string | undefined;
    for (let i = 1; i <= versuche; i++) {
      try {
        const r = await this.pruefe(p, zeitlimitS);
        if (r.ok) return { ok: true, text: r.text, versuche: i, ...(r.ausgabe ? { ausgabe: r.ausgabe } : {}) };
        letzter = r.text; ausgabe = r.ausgabe;
        // v1718 — Realfall 31.10. (8a26aed6 Schritt 67): pg_verifybackup scheiterte nach 1 s, gewartet wurde 70 min bis zum Zeitlimit.
        // Steht der Abbruch-Text in der Ausgabe, ist das Ergebnis klar — sofort als Fehler beenden.
        if (p.abbruch && (r.ausgabe ?? r.text).includes(p.abbruch)) return { ok: false, text: `Abbruch („${p.abbruch}“): ${r.text}`, versuche: i, ...(ausgabe ? { ausgabe } : {}) };
      } catch (err) { letzter = (err as Error).message.slice(0, 300); }
      if (i >= versuche) break;
      const abstand = typeof abstandMs === 'number' ? abstandMs : abstandMs(i);
      if (fristMs !== undefined) {
        const rest = fristMs - Date.now();
        if (rest <= 0) return { ok: false, text: letzter, versuche: i, ...(ausgabe ? { ausgabe } : {}) };
        await this.schlafe(Math.min(abstand, rest));
      } else await this.schlafe(abstand);
    }
    return { ok: false, text: letzter, versuche, ...(ausgabe ? { ausgabe } : {}) };
  }

  /** Eine Prüfung genau einmal. */
  async pruefe(p: Pruefung, zeitlimitS?: number): Promise<{ ok: boolean; text: string; ausgabe?: string }> {
    switch (p.typ) {
      case 'http': {
        const r = await this.d.netz.http(p.ziel!, 15_000);
        if (r.status >= 400) return { ok: false, text: `HTTP ${r.status}` };
        const t = textErfuellt(`${r.status}\n${r.text}`, p);
        return { ok: t.ok, text: t.ok ? `HTTP ${r.status}` : `HTTP ${r.status}, ${t.grund}` };
      }
      case 'port': { const ok = await this.d.netz.port(p.ziel!, p.port!, 5_000); return { ok, text: `${p.ziel}:${p.port} ${ok ? 'offen' : 'nicht erreichbar'}` }; }
      case 'dns': {
        let ips = await this.d.netz.dns(p.ziel!);
        let quelle = '';
        // v1683 — lokaler Resolver mit zwischengespeicherter Altantwort: öffentliche Resolver ohne Cache fragen
        if (p.erwartet && !ips.includes(p.erwartet) && this.d.netz.dnsFrisch) {
          const frisch = await this.d.netz.dnsFrisch(p.ziel!).catch(() => [] as string[]);
          if (frisch.includes(p.erwartet)) { ips = frisch; quelle = ' (öffentliche Resolver, lokal noch zwischengespeichert)'; }
        }
        const ok = ips.length > 0 && (!p.erwartet || ips.includes(p.erwartet));
        return { ok, text: `${p.ziel} → ${ips.join(', ') || 'keine Adresse'}${quelle}` };
      }
      case 'ping': { const ok = await this.d.netz.ping(p.ziel!); return { ok, text: `${p.ziel} ${ok ? 'antwortet' : 'antwortet nicht'}` }; }
      case 'container_healthy': {
        const c = leseDocker(await this.d.fernLesen(p.zugang!, LINUX_BEFEHLE.docker, 60_000)).find(x => x.name === p.container);
        if (!c) return { ok: false, text: `Container ${p.container} nicht gefunden` };
        const ok = c.zustand === 'running' && c.gesundheit !== 'unhealthy' && c.gesundheit !== 'starting';
        return { ok, text: `${c.name}: ${c.status}` };
      }
      case 'datei': {
        // v1652 — nur Metadaten (Typ, Größe): auch Pfade, deren Inhalt geheim ist, lassen sich so nachweisen
        try {
          const m = this.d.fernDatei ? await this.d.fernDatei(p.zugang!, p.pfad!, 30_000) : (await this.d.fernLesen(p.zugang!, `ls -la ${p.pfad}`, 30_000), '');
          return { ok: true, text: `${p.pfad} vorhanden${m ? ` (${m.slice(0, 80)})` : ''}` };
        }
        catch (err) { return { ok: false, text: `${p.pfad}: ${(err as Error).message.slice(0, 120)}` }; }
      }
      case 'befehl': {
        const t = await this.d.fernLesen(p.zugang!, p.befehl!, 60_000);
        const r = textErfuellt(t, p);
        return { ok: r.ok, text: r.ok ? `ok (${t.trim().split('\n').slice(-1)[0]?.slice(0, 80) ?? ''})` : r.grund!, ausgabe: t.slice(0, MAX_AUSGABE) };
      }
      case 'skill': {
        // v1843 — Realfall 13.11. (2ee9634f Schritt 2): windows_cluster.stabilitaet_pruefen beobachtet dauer_s (300 s) am Stück,
        // als Prüfung lief der Aufruf mit festen 60 s ins Zeitlimit. Beobachtende Prüfungen bekommen ihre Dauer plus Reserve.
        const dauer = Number((p.parameter as Record<string, unknown> | undefined)?.dauer_s);
        // Ruling R46 — Realfall 21.11. (2d2c5d5b Schritt 18): windows_ad.sql_anmeldung_pruefen läuft als geplante Aufgabe unter dem
        // Test-Konto (bis 120 s) und brach als Prüfung dreimal an den festen 60 s ab — der eigentliche Fehler blieb unsichtbar.
        // Ein Aufruf darf jetzt bis zum Zeitlimit des Schritts laufen (höchstens 40 min); 60 s bleiben die Untergrenze.
        const schritt = Number.isFinite(zeitlimitS) && zeitlimitS! > 0 ? Math.min(zeitlimitS!, 2_400) * 1000 : 0;
        const grenze = Math.max(Number.isFinite(dauer) && dauer > 0 ? Math.max(60_000, Math.min(dauer + 300, 2_400) * 1000) : 60_000, schritt);
        const r = await this.d.fuehreAus(p.skill!, { ...(p.parameter ?? {}), action: p.aktion! }, grenze);
        if (!r.success) return { ok: false, text: `${p.skill}.${p.aktion}: ${String(r.error ?? 'Fehler').slice(0, 160)}` };
        // v1717 — Realfall 30.10. (8a26aed6 Schritte 55–57): fernzugriff.lesen als Prüfung — die Anzeige enthält den Befehl selbst, und
        // der stand „print("ZEIT_ERREICHT" if … else "WARTEN")“; erwartet „ZEIT_ERREICHT“ traf den Befehlstext, Exit 1 zählte nicht.
        // Liefert ein Skill eine Befehlsausführung (code + stdout), zählt nur deren Ausgabe, und Exit ≠ 0 ist nicht erfüllt.
        const lauf = r.data as { code?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
        if (lauf && typeof lauf === 'object' && typeof lauf.code === 'number' && typeof lauf.stdout === 'string') {
          const aus = `${lauf.stdout}${typeof lauf.stderr === 'string' && lauf.stderr.trim() ? `\n${lauf.stderr}` : ''}`;
          if (lauf.code !== 0) return { ok: false, text: `${p.skill}.${p.aktion}: Exit ${lauf.code} (${lauf.stdout.trim().split('\n').slice(-1)[0]?.slice(0, 80) ?? ''})`, ausgabe: aus.slice(0, MAX_AUSGABE) };
          const t = textErfuellt(aus, p);
          return { ok: t.ok, text: t.ok ? `${p.skill}.${p.aktion} ok` : `${p.skill}.${p.aktion}: ${t.grund}`, ausgabe: aus.slice(0, MAX_AUSGABE) };
        }
        // v1643 — Realfall 24.10. (4c5652a5 Schritt 6): nur die WERTE der Daten durchsuchen — der Feldname „gesperrt“ (leere Liste) ließ
        // „darf GESPERRT nicht enthalten“ scheitern, obwohl alle Ports offen waren
        let daten = ''; try { daten = datenWerte(r.data).join('\n'); } catch { /* egal */ }
        const t = textErfuellt(`${r.display ?? ''}\n${daten}`, p);
        return { ok: t.ok, text: t.ok ? `${p.skill}.${p.aktion} ok` : `${p.skill}.${p.aktion}: ${t.grund}`, ausgabe: (r.display ?? daten).slice(0, MAX_AUSGABE) };
      }
    }
  }

  // ── Anhalten, Rückweg, Owner-Fragen ─────────────────────────

  private async halte(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, grund: string): Promise<void> {
    await this.d.nachStoerung?.(o, c, `angehalten: ${grund.slice(0, 200)}`).catch(() => undefined);
    lauf.phase = 'angehalten'; lauf.grund = grund;
    merkeVerlauf(lauf, { zeit: this.iso(), art: 'halt', schritt: lauf.schritt, text: grund }); // Dokument-Vorlagen: gespeichert mit dem Lauf unten
    if (!lauf.incidentId && this.d.incident) {
      lauf.incidentId = await this.d.incident.anlegen(o, { titel: `Change angehalten: ${c.title}`, text: `Change ${c.id} (${c.title}) angehalten.\n${grund}`, schwere: c.riskLevel === 'critical' || c.riskLevel === 'high' ? 'high' : 'medium', assetIds: c.affectedAssetIds }).catch(() => undefined);
    }
    const rw = rueckwegSchritte((c.schritte ?? []) as ChangeSchritt[], lauf.ergebnisse);
    // Owner 22.10. („ok zum offenen Vorschlag“; dreimal hat ein Ja auf die Rückweg-Frage einen fast fertigen Lauf zurückgerollt):
    // keine Ja/Nein-Frage mehr — Standard ist „angehalten lassen“; der Rückweg läuft nur auf ausdrücklichen Wunsch im Chat
    await this.d.itsm.motorSetze(o, c.id, { lauf });
    this.log('I4 Change angehalten', { id: c.id, grund: grund.slice(0, 300), incident: lauf.incidentId, rueckwegMoeglich: rw.length });
    await this.d.ereignis?.(o, c, 'stoerung', `Die Wartung „${c.title}“ ist angehalten: ${grund.slice(0, 200)}`).catch(() => undefined);
    await this.d.melde?.(`⚠️ Change angehalten: ${c.title} (${c.id.slice(0, 8)}) bei Schritt ${lauf.schritt}\n${grund}\n\nDer Change bleibt angehalten, bis du entscheidest (im Chat):\n• „Change ${c.id.slice(0, 8)} Schritt wiederholen“\n• „Change ${c.id.slice(0, 8)} abbrechen“ (ohne Rückweg)${ueberspringbar(lauf, c) ? `\n• „Change ${c.id.slice(0, 8)} Schritt überspringen“ (der Schritt liest/prüft nur)` : ''}${rw.length ? `\n• „Change ${c.id.slice(0, 8)} Rückweg ausführen“ — macht rückgängig: ${rw.map(s => `Schritt ${s.nr} (${s.rueckweg!.skill}.${s.rueckweg!.aktion})`).join(', ')}` : '\nEin Rückweg ist nicht nötig.'}`, true);
  }

  private async frageOwner(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, s: ChangeSchritt): Promise<void> {
    const nonce = randomUUID();
    lauf.phase = 'wartet_owner';
    lauf.frage = { art: 'owner_schritt', hash: hash(nonce), schritt: s.nr, bis: new Date(this.jetzt() + FRAGE_GUELTIG_MS).toISOString() };
    await this.d.itsm.motorSetze(o, c.id, { lauf });
    await this.d.fragenAufraeumen?.().catch(() => undefined); // v1688 — frühere Fragen dieses Changes (andere Nonce) verschwinden
    const ok = await this.d.frage?.(`🧑‍🔧 Change ${c.title} (${c.id.slice(0, 8)}), Schritt ${s.nr}: ${s.titel}\n${s.frage}\n\nErledigt? Nach deinem Ja geht es weiter.`, { action: 'owner_schritt_erledigt', change: c.id, schritt: s.nr, freigabe: nonce }).catch(() => false);
    this.log('I4 wartet auf Owner-Schritt', { id: c.id, nr: s.nr, frage: ok });
    await this.d.melde?.(`🧑‍🔧 Change ${c.title}: Schritt ${s.nr} braucht dich — ${s.frage}`, true);
  }

  /** Antwort auf eine Owner-Frage prüfen und verbrauchen (Hash, Gültigkeit, Art, Schritt). */
  private async verbrauche(o: string, id: string, art: 'owner_schritt' | 'rueckweg', nonce: unknown, schritt?: number): Promise<{ c: CmdbChangeRequest; lauf: ChangeLauf } | string> {
    const c = await this.d.itsm.hole(o, id);
    const l = c?.lauf as ChangeLauf | undefined;
    if (!c || !l?.frage || typeof nonce !== 'string') return 'Keine offene Frage zu diesem Change.';
    const passt = l.frage.art === art || (art === 'rueckweg' && l.frage.art === 'rueckweg_nach_stoerung');
    if (!passt || l.frage.hash !== hash(nonce) || Date.parse(l.frage.bis) < this.jetzt() || (schritt !== undefined && l.frage.schritt !== schritt)) return 'Diese Freigabe ist ungültig oder abgelaufen.';
    if (c.status !== (l.frage.art === 'rueckweg_nach_stoerung' ? 'completed' : 'in_progress')) return `Change ist ${c.status}.`;
    delete l.frage;
    await this.d.itsm.motorSetze(o, c.id, { lauf: l });
    return { c, lauf: l };
  }

  /** Owner-Ja zu einem Owner-Schritt → Schritt erledigt, weiter. */
  async ownerSchrittErledigt(o: string, id: string, schritt: number, nonce: unknown): Promise<string> {
    const v = await this.verbrauche(o, id, 'owner_schritt', nonce, schritt);
    if (typeof v === 'string') return v;
    v.lauf.ergebnisse = [...v.lauf.ergebnisse.filter(e => e.nr !== schritt), { nr: schritt, ok: true, start: this.iso(), ende: this.iso(), ausgabe: 'vom Owner bestätigt' }];
    v.lauf.schritt = schritt + 1; v.lauf.phase = 'laeuft';
    await this.d.itsm.motorSetze(o, v.c.id, { lauf: v.lauf });
    void this.weiter(o, v.c, v.lauf).catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
    return `Schritt ${schritt} als erledigt vermerkt — der Change läuft weiter.`;
  }

  /** Owner-Ja zum Rückweg. */
  async rueckwegNachJa(o: string, id: string, nonce: unknown): Promise<string> {
    const v = await this.verbrauche(o, id, 'rueckweg', nonce);
    if (typeof v === 'string') return v;
    void this.rueckweg(o, v.c, v.lauf, v.lauf.grund ?? 'vom Owner gewählt').catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
    return 'Rückweg läuft — ich melde das Ergebnis.';
  }

  /** Owner im Chat: angehaltenen Schritt wiederholen, abbrechen (ohne Rückweg) oder den Rückweg ausdrücklich ausführen. */
  async steuern(o: string, id: string, wahl: 'wiederholen' | 'abbrechen' | 'rueckweg' | 'ueberspringen', anlass?: 'freigabe'): Promise<string> {
    const r = await this.steuernIntern(o, id, wahl, anlass);
    await this.d.fragenAufraeumen?.().catch(() => undefined); // v1688 — Owner-Fragen eines abgebrochenen/wiederholten Schritts verschwinden
    return r;
  }

  /** anlass „freigabe“: der Motor setzt nach der Freigabe einer Korrektur selbst fort (kein Wiederholen durch den Owner) */
  private async steuernIntern(o: string, id: string, wahl: 'wiederholen' | 'abbrechen' | 'rueckweg' | 'ueberspringen', anlass?: 'freigabe'): Promise<string> {
    const c = await this.d.itsm.hole(o, id);
    const l = c?.lauf as ChangeLauf | undefined;
    // Rückweg nach einer Störung: abgeschlossener Change mit verknüpfter Störung
    if (wahl === 'rueckweg' && c && l && c.status === 'completed' && (l.stoerungen ?? []).length && !this.belegt(c.id)) {
      if (!rueckwegSchritte((c.schritte ?? []) as ChangeSchritt[], l.ergebnisse).length) return 'Dieser Change hat keinen Rückweg.';
      delete l.frage;
      void this.rueckweg(o, c, l, `Rückweg nach Störung auf Wunsch des Owners`).catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
      return 'Rückweg läuft — ich melde das Ergebnis.';
    }
    // v1640 — nie gestartet (Entwurf, eingereicht, freigegeben ohne Lauf): „abbrechen“ verwirft ihn
    if (wahl === 'abbrechen' && c && !l?.start && ['draft', 'submitted', 'approved'].includes(c.status) && !this.belegt(c.id)) {
      if (!this.d.itsm.verwerfen) return 'Verwerfen ist hier nicht verfügbar.';
      const vorher = c.status;
      await this.d.itsm.verwerfen(o, c.id, 'auf Wunsch des Owners');
      this.log('I4 Change verworfen', { id: c.id, vorher });
      return `Change ${c.id.slice(0, 8)} „${c.title}“ verworfen (war ${vorher === 'draft' ? 'in Planung' : vorher === 'submitted' ? 'zur Freigabe' : 'freigegeben, nicht gestartet'}).`;
    }
    if (!c || !l || c.status !== 'in_progress' || this.belegt(c.id)) return 'Der Change ist nicht angehalten.';
    // v1682 — Realfall 26.10. (Matrix J c89f6bd9): ein Change, der bei einem Owner-Schritt wartet, ließ sich weder in der App noch im Chat
    // abbrechen („nicht angehalten (Phase wartet_owner)“). Er steht wie ein angehaltener Change still — dieselben Wahlmöglichkeiten.
    if (l.phase !== 'angehalten' && l.phase !== 'wartet_owner') return `Der Change ist nicht angehalten (Phase ${l.phase}).`;
    delete l.frage;
    if (wahl === 'abbrechen') {
      merkeKorrektur(l);
      await this.beende(o, c, l, 'cancelled', 'vom Owner abgebrochen (ohne Rückweg)');
      // v1605 — Realfall 23.10.: nach dem Abbruch von 4f2642ab startete der wartende 9527d97f erst beim nächsten 10-Minuten-Takt
      void this.anstossen().catch(err => this.log('I4 Motorfehler', { id: c.id, fehler: (err as Error).message }));
      return 'Change abgebrochen, ohne Rückweg. Der Bericht steht im Change.';
    }
    if (wahl === 'rueckweg') {
      if (!rueckwegSchritte((c.schritte ?? []) as ChangeSchritt[], l.ergebnisse).length) return 'Es gibt nichts zurückzunehmen — „abbrechen“ beendet den Change.';
      merkeKorrektur(l);
      void this.rueckweg(o, c, l, l.grund ?? 'vom Owner gewählt').catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
      return 'Rückweg läuft — ich melde das Ergebnis.';
    }
    // v1661 — ab dem Haltepunkt korrigiert: weiter nur, wenn der Owner genau den neuen Plan freigegeben hat
    // v1759 — Realfall 03.11. (25958184): Aktion am Haltepunkt korrigiert → die neue Aktion läuft, nicht nur die Prüfung
    let aktionNeu = false;
    if (l.korrektur) {
      if (!c.freigabeFingerabdruck || c.freigabeFingerabdruck !== c.fingerabdruck) return `Der Plan wurde ab Schritt ${l.korrektur.abSchritt} korrigiert — er wartet auf deine Freigabe, danach geht es dort weiter.`;
      aktionNeu = !!l.korrektur.aktionGeaendert && l.korrektur.abSchritt === l.schritt;
      merkeKorrektur(l);
      delete l.korrektur;
    }
    const alt = l.ergebnisse.find(e => e.nr === l.schritt);
    const s = (c.schritte as ChangeSchritt[] | undefined)?.find(x => x.nr === l.schritt);
    // v1692 — Realfall 26.10. (5bcddc88): an einem LESENDEN Schritt angehalten (Ausfall pve1), alles Wirksame war durch — der Change
    // ließ sich nur abbrechen. Überspringen nur für Schritte, die nichts verändern, und nur ohne spätere Verweise auf ihr Ergebnis.
    if (wahl === 'ueberspringen') {
      if (!s || l.phase !== 'angehalten') return 'Überspringen geht nur an einem angehaltenen Schritt.';
      const verwendet = (c.schritte as ChangeSchritt[]).filter(x => x.nr > s.nr && new RegExp(`\\{\\{\\s*schritt${s.nr}\\.`).test(JSON.stringify(x))).map(x => x.nr);
      const lesend = s.art === 'pruefung' || s.art === 'warten' || (s.art === 'aktion' && !!s.skill && !!s.aktion && aktionsArt(s.skill, s.aktion, s.parameter) === 'lesen');
      if (!lesend) return `Schritt ${s.nr} „${s.titel}“ verändert etwas — überspringen geht nur bei lesenden, prüfenden oder wartenden Schritten. Möglich: wiederholen, Rückweg oder abbrechen.`;
      if (alt?.aktionOk || alt?.teilweise) return `Schritt ${s.nr} hat schon etwas bewirkt — nicht überspringbar.`;
      if (verwendet.length) return `Schritt ${s.nr} kann nicht übersprungen werden: Schritt ${verwendet.join(', ')} verwendet sein Ergebnis.`;
      const jetzt = this.iso();
      l.ergebnisse = [...l.ergebnisse.filter(e => e.nr !== s.nr), { nr: s.nr, ok: true, uebersprungen: true, start: alt?.start ?? jetzt, ende: jetzt, ausgabe: `vom Owner übersprungen (vorher: ${(l.grund ?? alt?.fehler ?? 'gescheitert').slice(0, 200)})` }];
      merkeVerlauf(l, { zeit: jetzt, art: 'ueberspringen', schritt: s.nr, text: `Schritt ${s.nr} „${s.titel}“ vom Owner übersprungen` });
      l.phase = 'laeuft'; delete l.grund;
      await this.d.itsm.motorSetze(o, c.id, { lauf: l });
      this.log('I4 Schritt übersprungen', { id: c.id, nr: s.nr });
      void this.weiter(o, c, l).catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
      const rest = (c.schritte as ChangeSchritt[]).filter(x => x.nr > s.nr).length;
      return rest ? `Schritt ${s.nr} übersprungen — es geht mit Schritt ${s.nr + 1} weiter.` : `Schritt ${s.nr} übersprungen — das war der letzte Schritt, der Change wird abgeschlossen.`;
    }
    const nurPruefung = !aktionNeu && !!(alt?.aktionOk && !alt.ok && s?.art === 'aktion' && s.pruefung);
    if (nurPruefung) l.nurPruefung = { nr: l.schritt, ...(alt!.ausgabe !== undefined ? { ausgabe: alt!.ausgabe } : {}), ...(alt!.daten !== undefined ? { daten: alt!.daten } : {}) };
    merkeVerlauf(l, { zeit: this.iso(), art: 'wiederholen', schritt: l.schritt, text: anlass === 'freigabe' ? `Schritt ${l.schritt}: nach Freigabe der Korrektur fortgesetzt` : nurPruefung ? `Schritt ${l.schritt}: nur die Prüfung erneut (Aktion war gelungen)` : `Schritt ${l.schritt} wird wiederholt` });
    l.ergebnisse = l.ergebnisse.filter(e => e.nr !== l.schritt); l.phase = 'laeuft'; delete l.grund;
    await this.d.itsm.motorSetze(o, c.id, { lauf: l });
    void this.weiter(o, c, l).catch(err => this.log('I4 Motorfehler', { id, fehler: (err as Error).message }));
    return nurPruefung ? `Schritt ${l.schritt}: Die Aktion war schon gelungen — nur die Prüfung läuft erneut.` : `Schritt ${l.schritt} wird wiederholt.`;
  }

  /**
   * I4b Teil 2 (Owner 22.10., 5b-13) — Störungen nach Abschluss: Ein offener Incident, der innerhalb von 24 h (kritische Services 72 h)
   * nach dem Ende eines Changes an einem seiner Assets oder einem davon abhängigen Asset entsteht, wird mit dem Change verknüpft.
   * Alfred meldet zeitkritisch und bietet den Rückweg NUR als Frage an („Rückweg nur vorschlagen, dann auf Freigabe warten“).
   */
  async pruefeStoerungen(incidents: Array<{ id: string; title: string; severity: string; status: string; affectedAssetIds: string[]; createdAt: string }>): Promise<number> {
    const o = this.d.owner(); if (!o) return 0;
    const jetzt = this.jetzt();
    let neu = 0;
    const alle = await this.d.itsm.liste(o);
    // Realfall 22.10. (Vorlage 9020 und Netz Docker-Dev zurückgerollt): Incidents, die der Motor beim Anhalten eines Changes selbst
    // anlegt, hat DIESER Change verursacht — nie einem anderen, früheren Change mit gemeinsamen Assets zuschreiben
    const eigeneIncidents = new Set(alle.map(x => (x.lauf as ChangeLauf | undefined)?.incidentId).filter((x): x is string => !!x));
    const offen = incidents.filter(i => !['resolved', 'closed'].includes(i.status) && i.affectedAssetIds?.length && !eigeneIncidents.has(i.id));
    if (!offen.length) return 0;
    for (const c of alle.filter(x => x.status === 'completed' && x.schritte?.length)) {
      const l = c.lauf as ChangeLauf | undefined;
      if (!l?.ende) continue;
      const ende = Date.parse(l.ende);
      const kritisch = !!(c.auswirkung as { kritisch?: boolean } | undefined)?.kritisch;
      const fenster = (kritisch ? 72 : 24) * 3_600_000;
      if (jetzt - ende > fenster) continue;
      const kandidaten = offen.filter(i => { const t = Date.parse(i.createdAt); return t >= ende && t <= ende + fenster && !(l.stoerungen ?? []).some(s => s.incidentId === i.id); });
      if (!kandidaten.length) continue;
      const bereich = new Set([...c.affectedAssetIds, ...(await this.d.abhaengigeIds?.(o, c.affectedAssetIds).catch(() => []) ?? [])]);
      const treffer = kandidaten.filter(i => i.affectedAssetIds.some(a => bereich.has(a)));
      if (!treffer.length) continue;
      l.stoerungen = [...(l.stoerungen ?? []), ...treffer.map(i => ({ incidentId: i.id, titel: i.title, schwere: i.severity, zeit: i.createdAt }))];
      const rw = rueckwegSchritte((c.schritte ?? []) as ChangeSchritt[], l.ergebnisse);
      // Owner 22.10.: Rückweg nie als Ja/Nein-Frage — nur Meldung mit dem ausdrücklichen Chat-Befehl
      await this.d.itsm.motorSetze(o, c.id, { lauf: l });
      for (const i of treffer) await this.d.incident?.notiz(o, i.id, `Möglicherweise durch Change ${c.id.slice(0, 8)} „${c.title}“ verursacht (abgeschlossen ${l.ende}, berührt dieselben Assets).${rw.length ? ' Rückweg nur auf ausdrücklichen Wunsch des Owners.' : ' Der Change hat keinen Rückweg.'}`).catch(() => undefined);
      this.log('I4b Störung nach Change', { id: c.id, incidents: treffer.map(i => i.id), kritisch, rueckwegMoeglich: rw.length });
      await this.d.melde?.(`🚨 Störung möglicherweise durch Change „${c.title}“ (${c.id.slice(0, 8)}, abgeschlossen ${new Date(ende).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' })}): ${treffer.map(i => `${i.title} (${i.severity})`).join('; ')}${rw.length ? `\nNur wenn du ihn wirklich zurücknehmen willst, im Chat: „Change ${c.id.slice(0, 8)} Rückweg ausführen“ — macht rückgängig: ${rw.map(s => `Schritt ${s.nr} (${s.rueckweg!.skill}.${s.rueckweg!.aktion})`).join(', ')}` : ''}`, true);
      await this.d.ereignis?.(o, c, 'stoerung', `Nach der Wartung „${c.title}“ ist eine Störung aufgetreten: ${treffer.map(i => i.title).join('; ')}`).catch(() => undefined);
      neu += treffer.length;
    }
    return neu;
  }

  private async rueckweg(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, grund: string): Promise<void> {
    this.laufend.add(c.id);
    try {
      lauf.phase = 'rueckweg'; lauf.grund = grund; lauf.rueckweg = lauf.rueckweg ?? [];
      await this.d.itsm.motorSetze(o, c.id, { lauf });
      const rw = rueckwegSchritte((c.schritte ?? []) as ChangeSchritt[], lauf.ergebnisse).filter(s => !lauf.rueckweg!.some(r => r.zuSchritt === s.nr && r.ok));
      let allesOk = true;
      for (const s of rw) {
        const frisch = await this.d.itsm.hole(o, c.id);
        if (!frisch || !this.freigabeDeckt(frisch, c)) { lauf.rueckweg = [...lauf.rueckweg!, { zuSchritt: s.nr, ok: false, text: 'Freigabe deckt den Plan nicht mehr — Rückweg nicht ausgeführt', zeit: this.iso() }]; allesOk = false; break; }
        const r = await this.mitGeheimnissen({ o, wofuer: `Change ${c.id.slice(0, 8)} Rückweg zu Schritt ${s.nr}`, vorgaenger: await this.vorgaenger(o, c) }, s.rueckweg!.skill!, s.rueckweg!.aktion!, s.rueckweg!.parameter ?? {}, lauf.ergebnisse, s.zeitlimitS * 1000).catch(err => ({ ok: false, fehler: (err as Error).message }));
        const eintrag = { zuSchritt: s.nr, ok: r.ok, text: r.ok ? `${s.rueckweg!.skill}.${s.rueckweg!.aktion} ok` : String(r.fehler ?? 'gescheitert').slice(0, 300), zeit: this.iso() };
        lauf.rueckweg = [...lauf.rueckweg!, eintrag];
        await this.d.itsm.motorSetze(o, c.id, { lauf });
        this.log('I4 Rückweg-Schritt', { id: c.id, zuSchritt: s.nr, ok: r.ok });
        if (!r.ok) { allesOk = false; break; }
      }
      if (this.d.incident && lauf.incidentId) await this.d.incident.notiz(o, lauf.incidentId, `Rückweg ${allesOk ? 'ausgeführt' : 'GESCHEITERT'}:\n${lauf.rueckweg!.map(r => `${r.ok ? '✓' : '✗'} zu Schritt ${r.zuSchritt}: ${r.text}`).join('\n')}`).catch(() => undefined);
      if (!allesOk && !lauf.incidentId && this.d.incident) lauf.incidentId = await this.d.incident.anlegen(o, { titel: `Rückweg gescheitert: ${c.title}`, text: grund, schwere: 'high', assetIds: c.affectedAssetIds }).catch(() => undefined);
      const quellen = [...new Set(((c.schritte ?? []) as ChangeSchritt[]).filter(wirkt).map(s => QUELLE[s.skill ?? '']).filter((q): q is string => !!q))];
      const disc = quellen.length && this.d.entdecke ? await this.d.entdecke(quellen, beruehrteHosts(((c.schritte ?? []) as ChangeSchritt[]).filter(wirkt))).catch(() => []) : [];
      await this.beende(o, c, lauf, allesOk ? 'rolled_back' : 'failed', grund, disc);
    } finally {
      this.laufend.delete(c.id);
    }
  }

  /** Nach einem Neustart: lesende Schritte einfach fortsetzen; mitten in einem ändernden Schritt oder Rückweg → anhalten und fragen. */
  private async nachNeustart(o: string, c: CmdbChangeRequest, lauf: ChangeLauf): Promise<void> {
    const s = ((c.schritte ?? []) as ChangeSchritt[]).find(x => x.nr === lauf.schritt);
    const unklar = lauf.phase === 'rueckweg' || (s && (wirkt(s) || s.art === 'owner') && !lauf.ergebnisse.some(e => e.nr === s.nr));
    this.log('I4 Change nach Neustart', { id: c.id, schritt: lauf.schritt, phase: lauf.phase, fortsetzen: !unklar });
    if (!unklar) { void this.weiter(o, c, lauf).catch(err => this.log('I4 Motorfehler', { id: c.id, fehler: (err as Error).message })); return; }
    await this.halte(o, c, lauf, lauf.phase === 'rueckweg' ? 'Neustart während des Rückwegs — Stand unklar' : `Neustart während Schritt ${lauf.schritt} „${s?.titel ?? '?'}“ — unklar, ob er ausgeführt wurde`);
  }

  private async beende(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, status: 'completed' | 'failed' | 'rolled_back' | 'cancelled', grund?: string, discovery: string[] = []): Promise<void> {
    if (status === 'failed' || status === 'rolled_back') await this.d.nachStoerung?.(o, c, `${status === 'failed' ? 'fehlgeschlagen' : 'zurückgerollt'}${grund ? `: ${grund.slice(0, 200)}` : ''}`).catch(() => undefined);
    lauf.phase = 'fertig'; lauf.ende = this.iso(); if (grund) lauf.grund = grund; delete lauf.frage;
    const bericht = laufBericht(c.title, (c.schritte ?? []) as ChangeSchritt[], lauf, status) + (discovery.length ? `\nDiscovery danach: ${discovery.join('; ')}` : '');
    const gespeichert = await this.d.itsm.motorSetze(o, c.id, { status: c.status === 'cancelled' ? undefined : status, lauf, result: bericht, linkedIncidentId: lauf.incidentId });
    // Realfall 28.11. (811c766d): Rückweg aus der Owner-Frage zu Schritt 7 — das Aufräumen in steuern() lief, bevor der Rückweg die Phase
    // setzte; die Frage „Schritt 7 erledigt?“ blieb nach dem Ende offen. Am Ende jedes Laufs sind alle Owner-Fragen dieses Changes veraltet.
    await this.d.fragenAufraeumen?.().catch(() => undefined);
    if (this.d.incident && lauf.incidentId) await this.incidentZumEnde(o, c, lauf, status, bericht);
    this.log('I4 Change beendet', { id: c.id, status, dauerS: Math.round((Date.parse(lauf.ende) - Date.parse(lauf.start)) / 1000), discovery });
    const sollIst = status === 'completed' && c.vorhabenId ? await this.d.nachAbschluss?.(o, c).catch(() => undefined) : undefined;
    // Empfänger der Benachrichtigungsregeln warten nicht auf das Protokoll
    await this.d.ereignis?.(o, c, status === 'failed' ? 'stoerung' : 'ende', `Die Wartung „${c.title}“ ist ${{ completed: 'abgeschlossen', failed: 'gescheitert', rolled_back: 'zurückgenommen', cancelled: 'abgebrochen' }[status]}.`).catch(() => undefined);
    const doku = await this.dokumentNachEnde(o, gespeichert ?? { ...c, lauf }, status);
    await this.d.melde?.(`${status === 'completed' ? '✅' : status === 'rolled_back' ? '⏪' : status === 'cancelled' ? '🚫' : '❌'} ${bericht}${sollIst ? `\n\n${sollIst}` : ''}${doku ? `\n\n📄 ${doku.zeile}` : ''}`, status === 'failed', doku?.anhaenge?.length ? doku.anhaenge : undefined);
  }

  /** Dokument-Vorlagen V2 — Abnahmeprotokoll nach dem Ende; wirft nie, wartet höchstens nachEndeZeitMs (danach folgt das Ergebnis als eigene Meldung). */
  private async dokumentNachEnde(o: string, c: CmdbChangeRequest, status: 'completed' | 'failed' | 'rolled_back' | 'cancelled'): Promise<{ zeile: string; anhaenge?: SkillResultAttachment[] } | undefined> {
    const hook = this.d.nachEnde;
    if (!hook) return undefined;
    const ms = this.d.nachEndeZeitMs ?? NACH_ENDE_ZEIT_MS;
    const fehler = (err: unknown) => schwaerze((err as Error)?.message ?? String(err)).text.slice(0, 300);
    // auch ein synchroner Wurf wird zur abgelehnten Promise
    const erzeugung = Promise.resolve().then(() => hook(o, c, status)).then(r => (typeof r === 'string' ? { zeile: r } : r));
    let zeitgeber: ReturnType<typeof setTimeout> | undefined;
    const grenze = new Promise<typeof ZEIT>(r => { zeitgeber = setTimeout(() => r(ZEIT), ms); });
    try {
      const r = await Promise.race([erzeugung, grenze]);
      if (r !== ZEIT) return r;
      this.log('Abnahmeprotokoll Zeitüberschreitung', { id: c.id, ms });
      const kopf = `📄 ${c.title} (${c.id.slice(0, 8)}): `;
      void erzeugung.then(
        async zeile => {
          this.log('Abnahmeprotokoll nach Zeitüberschreitung fertig', { id: c.id, zeile: zeile?.zeile });
          if (zeile) await this.d.melde?.(kopf + zeile.zeile, false, zeile.anhaenge?.length ? zeile.anhaenge : undefined);
        },
        async err => {
          this.log('Abnahmeprotokoll nach Zeitüberschreitung fehlgeschlagen', { id: c.id, fehler: fehler(err) });
          await this.d.melde?.(`${kopf}Abnahmeprotokoll nicht erstellt: ${fehler(err)}`, false);
        },
      ).catch(err => this.log('Abnahmeprotokoll-Folgemeldung fehlgeschlagen', { id: c.id, fehler: fehler(err) }));
      return { zeile: `Abnahmeprotokoll folgt in einer eigenen Meldung (Erzeugung dauert länger als ${Math.round(ms / 1000)} s)` };
    } catch (err) {
      this.log('Abnahmeprotokoll nach Change-Ende fehlgeschlagen', { id: c.id, fehler: fehler(err) });
      return { zeile: `Abnahmeprotokoll nicht erstellt: ${fehler(err)}` };
    } finally {
      clearTimeout(zeitgeber);
    }
  }

  /**
   * v1620 — Realfall 23.10.: 13 Incidents „Change angehalten“ blieben offen, obwohl ihre Changes längst sauber abgeschlossen, zurückgerollt
   * oder abgebrochen waren. Der eigene Incident hält nur fest, dass der Motor nicht weitermachte — er endet mit dem Change, außer es wirkt
   * noch etwas nach (gescheiterter Rückweg, Fehlschlag, Abbruch mit nicht zurückgenommener Wirkung): dann bleibt er offen und wird hoch.
   */
  private async incidentZumEnde(o: string, c: CmdbChangeRequest, lauf: ChangeLauf, status: 'completed' | 'failed' | 'rolled_back' | 'cancelled', bericht: string): Promise<void> {
    const inc = this.d.incident!; const id = lauf.incidentId!;
    const rest = restWirkung((c.schritte ?? []) as ChangeSchritt[], lauf);
    const geloest = status === 'completed' || (status !== 'failed' && !rest.length);
    if (geloest && inc.loese) {
      await inc.loese(o, id, `Change ${c.id.slice(0, 8)} ${{ completed: 'nach dem Anhalten abgeschlossen', rolled_back: 'vollständig zurückgerollt', cancelled: 'ohne verbliebene Wirkung abgebrochen', failed: 'gescheitert' }[status]}.\n${bericht}`).catch(() => undefined);
      return;
    }
    const offen = rest.length ? `\nNoch wirksam (nicht zurückgenommen): ${rest.map(s => `Schritt ${s.nr} „${s.titel}“`).join('; ')}` : '';
    await inc.notiz(o, id, `Change-Ende: ${status}${offen}\n${bericht}`).catch(() => undefined);
    if (!geloest) await inc.hochstufen?.(o, id).catch(() => undefined);
  }
}
